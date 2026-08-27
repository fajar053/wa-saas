import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import QRCode from "qrcode";
import OpenAI from "openai";
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import pino from "pino";

import User from "./models/User.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ DB Connected"))
  .catch(err => console.error("❌ DB Error:", err));

const activeSessions = new Map();

// --- AUTHENTICATION API ---
app.post("/api/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: "Email dan password wajib diisi!" });
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ email, password: hashedPassword });
    res.json({ success: true, message: "Register berhasil! Silakan login." });
  } catch (e) {
    res.status(400).json({ success: false, message: e.code === 11000 ? "Email sudah terdaftar!" : e.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ success: false, message: "Email atau Password salah!" });
    }
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET);
    res.json({ success: true, token, user });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- CONFIG & PROFILE API ---
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Unauthorized" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: "Token Invalid" });
  }
};

app.get("/api/config", verifyToken, async (req, res) => {
  const user = await User.findById(req.user.userId);
  const today = new Date().toISOString().split("T")[0];
  
  // Reset usage harian jika beda hari
  if (user.dailyUsage.date !== today) {
    user.dailyUsage = { count: 0, date: today };
    await user.save();
  }

  res.json({
    email: user.email,
    apiKey: user.apiKey,
    modelName: user.modelName,
    systemPrompt: user.systemPrompt,
    plan: user.plan,
    expiredAt: user.expiredAt,
    dailyUsage: user.dailyUsage.count,
    dailyLimit: user.plan === "free" ? 30 : "Unlimited"
  });
});

app.post("/api/config", verifyToken, async (req, res) => {
  const { apiKey, modelName, systemPrompt } = req.body;
  await User.findByIdAndUpdate(req.user.userId, { apiKey, modelName, systemPrompt });
  res.json({ success: true, message: "Pengaturan disimpan!" });
});

// --- BOT WA ENGINE ---
async function startUserBot(userId, socket) {
  const authFolder = path.join(process.cwd(), `auth_${userId}`);
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    auth: state,
    printQRInTerminal: false
  });

  activeSessions.set(userId, sock);
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && socket) {
      const qrUrl = await QRCode.toDataURL(qr);
      socket.emit("qr", qrUrl);
      socket.emit("status", "Scan QR Code");
    }
    if (connection === "open") {
      socket?.emit("status", "Connected");
      socket?.emit("ready");
    }
    if (connection === "close") {
      const isLogout = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      if (isLogout) {
        fs.rmSync(authFolder, { recursive: true, force: true });
        socket?.emit("status", "Disconnected");
      } else {
        startUserBot(userId, socket);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe || msg.key.remoteJid.endsWith("@g.us")) continue;
      
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!text) continue;

      const user = await User.findById(userId);
      if (!user || !user.apiKey) continue;

      const today = new Date().toISOString().split("T")[0];
      if (user.dailyUsage.date !== today) {
        user.dailyUsage = { count: 0, date: today };
      }

      // CEK BATAS KUOTA FREE
      if (user.plan === "free" && user.dailyUsage.count >= 30) {
        await sock.sendMessage(msg.key.remoteJid, { 
          text: "[Sistem Bot] Kuota balasan harian bot ini telah habis (30/30 chat). Silakan upgrade ke Premium untuk kuota unlimited." 
        });
        continue;
      }

      // CEK MASA AKTIF PREMIUM
      if (user.plan === "premium" && user.expiredAt && new Date() > new Date(user.expiredAt)) {
        await sock.sendMessage(msg.key.remoteJid, { text: "Masa berlangganan Premium bot telah habis. Silakan perpanjang." });
        continue;
      }

      try {
        const openai = new OpenAI({ apiKey: user.apiKey, baseURL: "https://openrouter.ai/api/v1" });
        const response = await openai.chat.completions.create({
          model: user.modelName,
          messages: [
            { role: "system", content: user.systemPrompt },
            { role: "user", content: text }
          ]
        });

        const reply = response.choices[0]?.message?.content || "Maaf, AI sedang error.";
        await sock.sendMessage(msg.key.remoteJid, { text: reply });

        // NAIKKAN HITUNGAN PEMAKAIAN
        user.dailyUsage.count += 1;
        await user.save();

      } catch (err) {
        console.error("AI Error:", err.message);
      }
    }
  });
}

io.on("connection", (socket) => {
  socket.on("start-bot", (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      startUserBot(decoded.userId, socket);
    } catch (e) {
      socket.emit("status", "Unauthorized");
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server ready di port ${PORT}`));
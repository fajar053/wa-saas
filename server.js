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

// --- AUTH API ---
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
  
  // Reset otomatis jika masuk ke hari baru
  if (user.dailyUsageDate !== today) {
    user.dailyUsageCount = 0;
    user.dailyUsageDate = today;
    await user.save();
  }

  res.json({
    email: user.email,
    apiKey: user.apiKey,
    modelName: user.modelName,
    systemPrompt: user.systemPrompt,
    isBotActive: user.isBotActive,
    plan: user.plan,
    expiredAt: user.expiredAt,
    dailyUsage: user.dailyUsageCount || 0,
    dailyLimit: user.plan === "free" ? 30 : "Unlimited"
  });
});

app.post("/api/config", verifyToken, async (req, res) => {
  const { apiKey, modelName, systemPrompt, isBotActive } = req.body;
  await User.findByIdAndUpdate(req.user.userId, { apiKey, modelName, systemPrompt, isBotActive });
  res.json({ success: true, message: "Pengaturan berhasil disimpan!" });
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
      if (!user) continue;

      if (!user.isBotActive) continue;

      if (!user.apiKey) {
        const errorMsg = "API Key OpenRouter belum diisi di dashboard.";
        socket?.emit("error-log", { time: new Date().toLocaleTimeString(), message: errorMsg, from: msg.key.remoteJid });
        await sock.sendMessage(msg.key.remoteJid, { text: "[Sistem] Layanan pembalas otomatis belum dikonfigurasi oleh pemilik." });
        continue;
      }

      const today = new Date().toISOString().split("T")[0];
      
      // Reset harian jika tanggal berbeda
      if (user.dailyUsageDate !== today) {
        user.dailyUsageCount = 0;
        user.dailyUsageDate = today;
        await user.save();
      }

      // CEK LIMIT FREE (30 Chat)
      if (user.plan === "free" && user.dailyUsageCount >= 30) {
        const limitMsg = "Batas kuota gratis harian (30 chat) telah tercapai.";
        socket?.emit("error-log", { time: new Date().toLocaleTimeString(), message: limitMsg, from: msg.key.remoteJid });
        await sock.sendMessage(msg.key.remoteJid, { text: "[Sistem] Maaf, kuota pembalasan harian bot ini telah habis (30/30)." });
        continue;
      }

      // CEK KEDALUWARSA PREMIUM
      if (user.plan === "premium" && user.expiredAt && new Date() > new Date(user.expiredAt)) {
        const expMsg = "Masa langganan Premium bot telah kedaluwarsa.";
        socket?.emit("error-log", { time: new Date().toLocaleTimeString(), message: expMsg, from: msg.key.remoteJid });
        await sock.sendMessage(msg.key.remoteJid, { text: "[Sistem] Masa berlangganan bot ini telah habis." });
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

        const reply = response.choices[0]?.message?.content || "Maaf, AI tidak memberikan respons.";
        await sock.sendMessage(msg.key.remoteJid, { text: reply });

        // MENAMBAH PENAMBAHAN HITUNGAN SECARA PASTI KE DATABASE
        await User.findByIdAndUpdate(userId, { $inc: { dailyUsageCount: 1 } });

      } catch (err) {
        console.error("AI Error:", err.message);
        socket?.emit("error-log", { time: new Date().toLocaleTimeString(), message: err.message, from: msg.key.remoteJid });
        await sock.sendMessage(msg.key.remoteJid, { 
          text: "[Sistem] Mohon maaf, terjadi kendala saat memproses balasan otomatis. Silakan coba beberapa saat lagi." 
        });
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
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
import makeWASocket, { 
  DisconnectReason, 
  fetchLatestBaileysVersion, 
  initAuthCreds, 
  BufferJSON 
} from "@whiskeysockets/baileys";
import pino from "pino";

import User from "./models/User.js";
import Session from "./models/Session.js";

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

// Connect Database
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ DB Connected");
    // Auto-start bot untuk semua user yang punya session terhubung di DB
    autoStartAllSessions();
  })
  .catch(err => console.error("❌ DB Error:", err));

const activeSessions = new Map();
const userSockets = new Map(); // Menyimpan socket per user ID

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
  
  if (user.dailyUsageDate !== today) {
    user.dailyUsageDate = today;
    user.dailyUsageCount = 0;
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

// --- CUSTOM MONGODB AUTH STATE ---
async function useMongoDBAuthState(userId) {
  let session = await Session.findOne({ userId });
  let creds;
  let keys = {};

  if (session && session.data) {
    try {
      const parsed = JSON.parse(session.data, BufferJSON.reviver);
      creds = parsed.creds;
      keys = parsed.keys || {};
    } catch (e) {
      creds = initAuthCreds();
    }
  } else {
    creds = initAuthCreds();
  }

  const saveCreds = async () => {
    const dataStr = JSON.stringify({ creds, keys }, BufferJSON.replacer);
    await Session.findOneAndUpdate(
      { userId: String(userId) },
      { data: dataStr },
      { upsert: true, new: true }
    );
  };

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const data = keys[type] || {};
          return ids.reduce((acc, id) => {
            if (data[id]) acc[id] = data[id];
            return acc;
          }, {});
        },
        set: async (data) => {
          for (const type in data) {
            if (!keys[type]) keys[type] = {};
            for (const id in data[type]) {
              const value = data[type][id];
              if (value) {
                keys[type][id] = value;
              } else {
                delete keys[type][id];
              }
            }
          }
          await saveCreds();
        }
      }
    },
    saveCreds
  };
}

// --- AUTO RECONNECT SEMUA SESSION DARI DB ---
async function autoStartAllSessions() {
  try {
    const sessions = await Session.find({});
    for (const session of sessions) {
      if (!activeSessions.has(session.userId)) {
        console.log(`🔄 Restoring WA Session for User ID: ${session.userId}`);
        startUserBot(session.userId);
      }
    }
  } catch (e) {
    console.error("Error restoring sessions:", e.message);
  }
}

// --- BOT WA ENGINE ---
async function startUserBot(userId, socket = null) {
  if (socket) userSockets.set(String(userId), socket);

  const { state, saveCreds } = await useMongoDBAuthState(userId);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    auth: state,
    printQRInTerminal: false
  });

  activeSessions.set(String(userId), sock);
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const currentSocket = userSockets.get(String(userId));

    if (qr && currentSocket) {
      const qrUrl = await QRCode.toDataURL(qr);
      currentSocket.emit("qr", qrUrl);
      currentSocket.emit("status", "Scan QR Code");
    }
    if (connection === "open") {
      console.log(`✅ WA Connected for User: ${userId}`);
      currentSocket?.emit("status", "Connected");
      currentSocket?.emit("ready");
    }
    if (connection === "close") {
      const isLogout = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      if (isLogout) {
        await Session.deleteOne({ userId: String(userId) });
        activeSessions.delete(String(userId));
        currentSocket?.emit("status", "Disconnected");
      } else {
        startUserBot(userId, currentSocket);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe || msg.key.remoteJid.endsWith("@g.us")) continue;

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (!text) continue;

      // Auto read chat
      try {
        await sock.readMessages([msg.key]);
      } catch (e) {}

      const senderNumber = msg.key.remoteJid.split("@")[0].split(":")[0];
      const targetSocket = userSockets.get(String(userId));

      // Emit log chat masuk ke dashboard
      targetSocket?.emit("chat-log", {
        time: new Date().toLocaleTimeString(),
        sender: senderNumber,
        text: text,
        type: "in"
      });

      const user = await User.findById(userId);
      if (!user) continue;

      if (!user.isBotActive) continue;

      if (!user.apiKey) {
        const errorMsg = "API Key OpenRouter belum diisi.";
        targetSocket?.emit("error-log", { time: new Date().toLocaleTimeString(), message: errorMsg, from: senderNumber });
        await sock.sendMessage(msg.key.remoteJid, { text: "[Sistem] Layanan pembalas otomatis belum dikonfigurasi." });
        continue;
      }

      const today = new Date().toISOString().split("T")[0];
      if (user.dailyUsageDate !== today) {
        user.dailyUsageDate = today;
        user.dailyUsageCount = 0;
        await user.save();
      }

      // Limit Check
      if (user.plan === "free" && user.dailyUsageCount >= 30) {
        const limitMsg = "Batas kuota gratis harian (30 chat) telah tercapai.";
        targetSocket?.emit("error-log", { time: new Date().toLocaleTimeString(), message: limitMsg, from: senderNumber });
        await sock.sendMessage(msg.key.remoteJid, { text: "[Sistem] Maaf, kuota pembalasan harian bot ini telah habis (30/30)." });
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

        await User.findByIdAndUpdate(userId, { $inc: { dailyUsageCount: 1 } });

        targetSocket?.emit("chat-log", {
          time: new Date().toLocaleTimeString(),
          sender: senderNumber,
          text: reply,
          type: "out"
        });

      } catch (err) {
        console.error("AI Error:", err.message);
        targetSocket?.emit("error-log", { time: new Date().toLocaleTimeString(), message: err.message, from: senderNumber });
        await sock.sendMessage(msg.key.remoteJid, { 
          text: "[Sistem] Mohon maaf, terjadi kendala saat memproses balasan otomatis. Silakan coba beberapa saat lagi." 
        });
      }
    }
  });
}

// SOCKET.IO REALTIME
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
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
import crypto from "crypto";
import { Resend } from "resend";
import multer from "multer";
import QRCode from "qrcode";
import makeWASocket, { 
  DisconnectReason, 
  fetchLatestBaileysVersion, 
  initAuthCreds, 
  BufferJSON 
} from "@whiskeysockets/baileys";
import pino from "pino";

import User from "./models/User.js";
import Session from "./models/Session.js";
import Conversation from "./models/Conversation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Inisialisasi Client Resend Email API
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (!fs.existsSync(path.join(__dirname, "uploads"))) {
  fs.mkdirSync(path.join(__dirname, "uploads"));
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `avatar_${req.user.userId}_${Date.now()}${ext}`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 1 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error("Hanya file gambar (JPG, PNG, WEBP, GIF) yang diperbolehkan!"));
    }
  }
});

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ DB Connected");
    autoStartAllSessions();
  })
  .catch(err => console.error("❌ DB Error:", err));

const activeSessions = new Map();
const isStartingSession = new Set();
const connectedFlags = new Set();
const userSockets = new Map();

// --- HELPER OPENROUTER API KHUSUS DI SERVER.JS ---
async function fetchOpenRouterAI(apiKey, messages, modelCandidate = "openrouter/auto", targetSocket = null, senderNumber = "") {
  const modelsToTry = [
    modelCandidate,
    "openrouter/auto",
    "openrouter/free",
    "openrouter/auto-beta",
    "openrouter/fusion",
    "dots-studio/dots-3-note-preview:free",
    "inclusionai/ling-3.0-flash-fin:free",
    "z-ai/glm-5.2:free",
    "nvidia/nemotron-3.5-lightning:free",
    "minimax/minimax-m3:free"
  ];

  const uniqueModels = [...new Set(modelsToTry)];

  for (const model of uniqueModels) {
    let retries = 3;
    while (retries > 0) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
            "X-Title": "WA AutoBot AI"
          },
          body: JSON.stringify({
            model: model,
            messages: messages,
            route: "fallback"
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          const errText = await response.text();
          console.warn(`⚠️ OpenRouter Model ${model} Failed (${response.status}): ${errText}`);
          if (response.status === 429) break;
          retries--;
          if (retries === 0) break;
          continue;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          console.log(`✅ AI Response Generated via Model: ${model}`);
          return content;
        }

      } catch (err) {
        console.warn(`⚠️ OpenRouter Model ${model} Connection Error: ${err.message}`);
        retries--;
        if (retries === 0) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  throw new Error("Koneksi ke server AI tidak stabil / terputus. Silakan coba beberapa saat lagi.");
}

// --- AUTH & CONFIG API ---
app.post("/api/register", async (req, res) => {
  try {
    const { nickname, username, email, password, confirmPassword } = req.body;
    if (!nickname || !username || !email || !password || !confirmPassword) {
      return res.status(400).json({ success: false, message: "Semua field wajib diisi!" });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ success: false, message: "Konfirmasi password tidak cocok!" });
    }
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(400).json({ success: false, message: "Email atau Username sudah terdaftar!" });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const defaultAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}`;

    await User.create({
      nickname, username, email, password: hashedPassword, verificationToken, profilePicture: defaultAvatar
    });

    const verifyLink = `${process.env.APP_URL || 'http://localhost:3000'}/api/verify-email?token=${verificationToken}`;
    try {
      await resend.emails.send({
        from: "WA AutoBot AI <noreply@wasaas.my.id>",
        to: [email],
        subject: "Aktivasi Akun WA AutoBot AI",
        html: `<h3>Halo ${nickname},</h3><p>Klik tombol untuk verifikasi email:</p><a href="${verifyLink}">Aktivasi Akun Saya</a>`
      });
      res.json({ success: true, message: "Pendaftaran berhasil! Silakan cek email kamu." });
    } catch (mailErr) {
      res.json({ success: true, message: `Pendaftaran berhasil! Link verifikasi: ${verifyLink}` });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/api/verify-email", async (req, res) => {
  try {
    const { token } = req.query;
    const user = await User.findOne({ verificationToken: token });
    if (!user) return res.send("Token tidak valid.");
    user.isVerified = true;
    user.verificationToken = null;
    await user.save();
    const loginToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET);
    res.send(`<script>localStorage.setItem('token', '${loginToken}'); window.location.href='/dashboard.html';</script>`);
  } catch (e) {
    res.status(500).send("Error server.");
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ success: false, message: "Email atau Password salah!" });
    }
    if (!user.isVerified) {
      return res.status(400).json({ success: false, message: "Akun belum diverifikasi!" });
    }
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET);
    res.json({ success: true, token, user });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

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
  const now = new Date();
  const resetDate = user.weeklyResetDate ? new Date(user.weeklyResetDate) : new Date(0);
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  if (!user.weeklyResetDate || (now - resetDate) >= sevenDaysMs) {
    user.weeklyResetDate = now;
    user.weeklyUsageCount = 0;
    await user.save();
  }

  res.json({
    email: user.email,
    nickname: user.nickname,
    username: user.username,
    profilePicture: user.profilePicture || `https://api.dicebear.com/7.x/bottts/svg?seed=${user.username}`,
    apiKey: user.apiKey,
    modelName: user.modelName || "openrouter/auto",
    systemPrompt: user.systemPrompt,
    isBotActive: user.isBotActive,
    plan: user.plan || "free",
    weeklyUsage: user.weeklyUsageCount || 0,
    weeklyLimit: user.plan === "premium" ? "Unlimited" : 200
  });
});

app.post("/api/config", verifyToken, async (req, res) => {
  const { apiKey, modelName, systemPrompt, isBotActive } = req.body;
  await User.findByIdAndUpdate(req.user.userId, { apiKey, modelName, systemPrompt, isBotActive });
  res.json({ success: true, message: "Pengaturan berhasil disimpan!" });
});

app.post("/api/generate-prompt", verifyToken, async (req, res) => {
  try {
    const { promptText, mode } = req.body;
    const user = await User.findById(req.user.userId);
    if (!user || !user.apiKey) {
      return res.status(400).json({ success: false, message: "API Key OpenRouter belum diisi!" });
    }
    const wordTarget = mode === "very_detailed" ? "700" : "100";
    const messages = [
      { role: "system", content: "Kamu adalah AI Prompt Engineer. Buatkan System Prompt WhatsApp komprehensif tanpa teks basa-basi pembuka." },
      { role: "user", content: `Kembangkan prompt berikut (${wordTarget} kata): "${promptText}"` }
    ];
    const generatedPrompt = await fetchOpenRouterAI(user.apiKey, messages, "openrouter/auto");
    res.json({ success: true, generatedPrompt });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/whatsapp/reset", verifyToken, async (req, res) => {
  try {
    const strUserId = String(req.user.userId);
    if (activeSessions.has(strUserId)) {
      try { activeSessions.get(strUserId).logout(); } catch (e) {}
      activeSessions.delete(strUserId);
    }
    await Session.deleteOne({ userId: strUserId });
    res.json({ success: true, message: "Sesi WhatsApp berhasil direset." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

async function useMongoDBAuthState(userId) {
  let session = await Session.findOne({ userId: String(userId) });
  let creds, keys = {};
  if (session && session.data) {
    try {
      const parsed = JSON.parse(session.data, BufferJSON.reviver);
      creds = parsed.creds || initAuthCreds();
      keys = parsed.keys || {};
    } catch (e) {
      creds = initAuthCreds();
    }
  } else {
    creds = initAuthCreds();
  }

  const saveCreds = async () => {
    try {
      const dataStr = JSON.stringify({ creds, keys }, BufferJSON.replacer);
      await Session.findOneAndUpdate({ userId: String(userId) }, { data: dataStr }, { upsert: true, new: true });
    } catch (err) {}
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
              if (data[type][id]) keys[type][id] = data[type][id];
              else delete keys[type][id];
            }
          }
          await saveCreds();
        }
      }
    },
    saveCreds
  };
}

async function autoStartAllSessions() {
  try {
    const sessions = await Session.find({});
    for (const session of sessions) {
      if (!activeSessions.has(String(session.userId))) {
        startUserBot(session.userId);
      }
    }
  } catch (e) {}
}

async function startUserBot(userId, socket = null) {
  const strUserId = String(userId);
  if (socket) userSockets.set(strUserId, socket);
  if (isStartingSession.has(strUserId)) return;
  isStartingSession.add(strUserId);

  try {
    const { state, saveCreds } = await useMongoDBAuthState(strUserId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: true,
      syncFullHistory: false
    });

    activeSessions.set(strUserId, sock);
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const currentSocket = userSockets.get(strUserId);

      if (qr && currentSocket) {
        const qrUrl = await QRCode.toDataURL(qr);
        currentSocket.emit("qr", qrUrl);
        currentSocket.emit("status", "Scan QR Code");
      }

      if (connection === "open") {
        isStartingSession.delete(strUserId);
        currentSocket?.emit("status", "Connected");
        currentSocket?.emit("ready");
      }

      if (connection === "close") {
        isStartingSession.delete(strUserId);
        activeSessions.delete(strUserId);
        if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
          await Session.deleteOne({ userId: strUserId });
          currentSocket?.emit("status", "Disconnected");
        } else {
          setTimeout(() => startUserBot(strUserId, currentSocket), 3000);
        }
      }
    });

    sock.ev.on("messages.upsert", async (chatUpdate) => {
      try {
        const { messages, type } = chatUpdate;
        if (type !== "notify" && type !== "append") return;

        for (const msg of messages) {
          if (!msg.message || msg.key.fromMe || msg.key.remoteJid.endsWith("@g.us")) continue;

          const user = await User.findById(strUserId);
          if (!user || !user.isBotActive) continue;

          const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
          if (!text) continue;

          const senderNumber = msg.key.remoteJid.split("@")[0].split(":")[0];
          const targetSocket = userSockets.get(strUserId);

          targetSocket?.emit("chat-log", {
            time: new Date().toLocaleTimeString(),
            sender: senderNumber,
            text: text,
            type: "in"
          });

          if (!user.apiKey) {
            targetSocket?.emit("error-log", { time: new Date().toLocaleTimeString(), message: "API Key belum diisi", from: senderNumber });
            continue;
          }

          if (user.plan === "free" && (user.weeklyUsageCount || 0) >= 200) {
            await sock.sendMessage(msg.key.remoteJid, { text: "[Sistem] Kuota mingguan bot telah habis (200/200)." });
            continue;
          }

          let conv = await Conversation.findOne({ botUserId: strUserId, senderNumber });
          if (!conv) {
            conv = await Conversation.create({ botUserId: strUserId, senderNumber, messages: [] });
          }

          conv.messages.push({ role: "user", content: text });
          const historyForAI = conv.messages.slice(-20).map(m => ({ role: m.role, content: m.content }));
          const messagesPayload = [{ role: "system", content: user.systemPrompt || "Kamu asisten AI ramah." }, ...historyForAI];

          try {
            // MENGGUNAKAN MODEL PILIHAN DARI DATABASE USER
            const selectedModel = user.modelName || "openrouter/auto";
            const reply = await fetchOpenRouterAI(user.apiKey, messagesPayload, selectedModel, targetSocket, senderNumber);

            conv.messages.push({ role: "assistant", content: reply });
            await conv.save();

            await sock.sendMessage(msg.key.remoteJid, { text: reply });
            await User.findByIdAndUpdate(strUserId, { $inc: { weeklyUsageCount: 1 } });

            targetSocket?.emit("chat-log", {
              time: new Date().toLocaleTimeString(),
              sender: senderNumber,
              text: reply,
              type: "out"
            });
          } catch (err) {
            targetSocket?.emit("error-log", { time: new Date().toLocaleTimeString(), message: err.message, from: senderNumber });
          }
        }
      } catch (e) {}
    });
  } catch (error) {
    isStartingSession.delete(strUserId);
  }
}

io.on("connection", (socket) => {
  socket.on("start-bot", (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      userSockets.set(String(decoded.userId), socket);
      startUserBot(decoded.userId, socket);
    } catch (e) {}
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server ready di port ${PORT}`));
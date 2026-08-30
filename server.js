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
import Transaction from "./models/Transaction.js";

// --- PREVENT PROCESS CRASH ---
process.on("unhandledRejection", (reason) => {
  console.error("⚠️ [UNHANDLED REJECTION]:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("⚠️ [UNCAUGHT EXCEPTION]:", err);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const resend = new Resend(process.env.RESEND_API_KEY);
const globalLogger = pino({ level: "fatal" });

// --- KONFIGURASI MULTI-PROVIDER AI & ROTATING GATEWAYS ---
const AI_PROVIDERS = [
  {
    name: "Orcarouter",
    apiKey: process.env.ORCAROUTER_API_KEY || "sk-orca-x9zTIrLjQRpAzGuFH8UotyjXEqzujt5nNIZukJ8n7Qk",
    baseUrl: process.env.ORCAROUTER_API_URL || "https://api.orcarouter.ai/v1/chat/completions",
    models: ["qwen/qwen3.8-27b-free", "orcarouter/free", "deepseek/deepseek-v4-flash-free"]
  },
  {
    name: "Teamrouter",
    apiKey: process.env.TEAMROUTER_API_KEY || "sk-teamo-0990530c5810e95c2433ee99def18de8f7b3d1dcb5ba6505",
    baseUrl: process.env.TEAMROUTER_API_URL || "https://api.teamrouter.ai/v1/chat/completions",
    models: ["deepseek-v4-pro-free", "glm-5.3-flash-free"]
  },
  {
    name: "Sambanova",
    apiKey: process.env.SAMBANOVA_API_KEY || "fc5715aa-7978-4005-9295-ce468f3c6fc2",
    baseUrl: process.env.SAMBANOVA_API_URL || "https://api.sambanova.ai/v1/chat/completions",
    models: ["Meta-Llama-3.3-70B-Instruct"]
  },
  {
    name: "Xkiro",
    apiKey: process.env.XKIRO_API_KEY || "sk-xt-e591956b1e15545d7ef1eb4b0b69c96adc15d48799c9ac6f",
    baseUrl: process.env.XKIRO_API_URL || "https://api.xkiro.ai/v1/chat/completions",
    models: ["qwen/qwen3.8-max:free", "deepseek/deepseek-v4-flash"]
  }
];

let activeProviderIndex = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- HELPER CALL MULTI-GATEWAY AI (ROBUST FAILOVER) ---
async function fetchAIResponse(messages, strUserId = "", timeoutMs = 6000) {
  const totalProviders = AI_PROVIDERS.length;
  const startProviderIndex = activeProviderIndex;
  activeProviderIndex = (activeProviderIndex + 1) % totalProviders;

  for (let attempt = 0; attempt < totalProviders; attempt++) {
    const currentIdx = (startProviderIndex + attempt) % totalProviders;
    const provider = AI_PROVIDERS[currentIdx];

    for (const model of provider.models) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(provider.baseUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${provider.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": process.env.APP_URL || "https://wasaas.my.id",
            "X-Title": "WA AutoBot SaaS"
          },
          body: JSON.stringify({ model, messages }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if ([400, 401, 403, 404].includes(response.status)) {
          console.warn(`❌ [AI HTTP ${response.status}] ${provider.name} (${model}). Lanjut provider lain...`);
          break;
        }

        if (!response.ok) {
          await sleep(300);
          continue;
        }

        const data = await response.json().catch(() => null);
        const content = data?.choices?.[0]?.message?.content;

        if (content && content.trim()) {
          console.log(`✅ [AI RESPONDED] Provider: ${provider.name} | Model: ${model}`);
          return content.trim();
        }
      } catch (err) {
        clearTimeout(timeoutId);
        console.warn(`⚠️ [AI TIMEOUT/ERR] ${provider.name} (${model}): ${err.message}`);
      }
    }
  }

  // Jika seluruh AI gagal, kembalikan pesan ramah agar bot TIDAK diam saja
  return "Maaf, saat ini sistem AI sedang mengalami kepadatan lalu lintas pesan. Silakan ulangi pesan Anda beberapa saat lagi 🙏";
}

// --- HELPER EKSTRAKSI TEKS PESAN WHATSAPP ---
function extractMessageText(msg) {
  if (!msg || !msg.message) return "";
  let m = msg.message;

  if (m.ephemeralMessage) m = m.ephemeralMessage.message || m;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message || m;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message || m;
  if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message || m;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message || m;
  if (m.editedMessage) m = m.editedMessage.message?.protocolMessage?.editedMessage || m;

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedId ||
    ""
  ).trim();
}

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
    if (extname && mimetype) return cb(null, true);
    cb(new Error("Hanya file gambar yang diperbolehkan!"));
  }
});

// Database Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ DB Connected");
    autoStartAllSessions();
  })
  .catch(err => console.error("❌ DB Error:", err));

const activeSessions = new Map();
const isStartingSession = new Set();
const processedMsgIds = new Set();
const messageBuffers = new Map();

// --- AUTHENTICATION & API ---
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

    await User.create({
      nickname,
      username,
      email,
      password: hashedPassword,
      verificationToken,
      profilePicture: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}`
    });

    const verifyLink = `${process.env.APP_URL || 'https://wasaas.my.id'}/api/verify-email?token=${verificationToken}`;
    
    try {
      await resend.emails.send({
        from: "WA AutoBot AI <noreply@wasaas.my.id>",
        to: [email],
        subject: "Aktivasi Akun WA AutoBot AI",
        html: `<h3>Halo ${nickname},</h3><p>Klik link berikut untuk verifikasi email kamu:</p><a href="${verifyLink}">${verifyLink}</a>`
      });
      res.json({ success: true, message: "Pendaftaran berhasil! Cek email untuk verifikasi." });
    } catch {
      res.json({ success: true, message: `Pendaftaran berhasil! Klik link verifikasi ini: ${verifyLink}` });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/api/verify-email", async (req, res) => {
  try {
    const { token } = req.query;
    const user = await User.findOne({ verificationToken: token });
    if (!user) return res.send("<h2>Token tidak valid / expired.</h2>");

    user.isVerified = true;
    user.verificationToken = null;
    await user.save();

    const loginToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET);
    res.send(`
      <script>
        localStorage.setItem('token', '${loginToken}');
        window.location.href = '/dashboard.html';
      </script>
      <h2>Verifikasi Berhasil! Mengalihkan ke Dashboard...</h2>
    `);
  } catch {
    res.status(500).send("Terjadi kesalahan.");
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
  if (!user) return res.status(404).json({ message: "User not found" });

  const today = new Date().toISOString().split("T")[0];
  if (user.dailyUsageDate !== today) {
    user.dailyUsageDate = today;
    user.dailyUsageCount = 0;
    await user.save();
  }

  let remainingDays = 0;
  if (user.plan === "premium" && user.expiredAt) {
    const now = new Date();
    if (user.expiredAt < now) {
      user.plan = "free";
      await user.save();
    } else {
      const diffTime = user.expiredAt.getTime() - now.getTime();
      remainingDays = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    }
  }

  res.json({
    email: user.email,
    nickname: user.nickname,
    username: user.username,
    profilePicture: user.profilePicture || `https://api.dicebear.com/7.x/bottts/svg?seed=${user.username}`,
    systemPrompt: user.systemPrompt,
    isBotActive: user.isBotActive ?? true,
    plan: user.plan || "free",
    remainingDays: remainingDays,
    dailyUsage: user.dailyUsageCount || 0,
    dailyLimit: user.plan === "premium" ? "Unlimited" : 50
  });
});

app.post("/api/config", verifyToken, async (req, res) => {
  try {
    const { systemPrompt, isBotActive } = req.body;
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ success: false, message: "User tidak ditemukan" });

    user.systemPrompt = systemPrompt;
    user.isBotActive = isBotActive;

    await user.save();
    res.json({ success: true, message: "Pengaturan berhasil disimpan!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/profile/update", verifyToken, async (req, res) => {
  try {
    const { profilePicture, nickname } = req.body;
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ success: false, message: "User tidak ditemukan" });

    if (profilePicture) user.profilePicture = profilePicture;
    if (nickname) user.nickname = nickname;

    await user.save();
    res.json({ success: true, message: "Profil berhasil diperbarui!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- API PUTUSKAN KONEKSI / LOGOUT WHATSAPP ---
app.post("/api/session/disconnect", verifyToken, async (req, res) => {
  try {
    const strUserId = String(req.user.userId);
    if (activeSessions.has(strUserId)) {
      const sock = activeSessions.get(strUserId);
      try { await sock.logout(); } catch { try { sock.end(); } catch {} }
      activeSessions.delete(strUserId);
    }
    await Session.deleteOne({ userId: strUserId });
    io.to(strUserId).emit("status", "Disconnected");
    res.json({ success: true, message: "Koneksi WhatsApp berhasil diputuskan!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/history/clear", verifyToken, async (req, res) => {
  try {
    await Conversation.deleteMany({ botUserId: String(req.user.userId) });
    res.json({ success: true, message: "Semua riwayat percakapan berhasil dibersihkan!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/generate-prompt", verifyToken, async (req, res) => {
  try {
    const { promptText, mode } = req.body;
    const user = await User.findById(req.user.userId);

    const wordTarget = mode === "very_detailed" ? "700" : "100";
    const systemInstruction = `Kamu adalah AI Prompt Engineer. Kembangkan instruksi singkat menjadi System Prompt/Pelatihan Bot WhatsApp dalam Bahasa Indonesia (~${wordTarget} kata). Langsung keluarkan teks prompt-nya tanpa kata pembuka/penutup.`;

    const messages = [
      { role: "system", content: systemInstruction },
      { role: "user", content: promptText }
    ];

    const generatedPrompt = await fetchAIResponse(messages, String(user._id));
    res.json({ success: true, generatedPrompt });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- FITUR INTEGRASI PEMBAYARAN AUTOMATIS MOOTA ---
app.post("/api/subscribe/create-moota", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { planType } = req.body;

    let baseAmount = 15000;
    let durationDays = 30;

    if (planType === "1_year") {
      baseAmount = 99000;
      durationDays = 365;
    }

    let existingTx = await Transaction.findOne({ userId, status: "pending", planType: planType || "1_month" });
    if (existingTx) {
      return res.json({
        success: true,
        data: {
          orderId: existingTx.orderId,
          totalAmount: existingTx.totalAmount,
          uniqueCode: existingTx.uniqueCode,
          bankName: "BNI",
          accountNumber: "1275951171",
          accountHolder: "Muhammad Fajar Firdaus"
        }
      });
    }

    let uniqueCode;
    let isCodeTaken = true;
    while (isCodeTaken) {
      uniqueCode = Math.floor(100 + Math.random() * 900);
      const checkTx = await Transaction.findOne({ totalAmount: baseAmount + uniqueCode, status: "pending" });
      if (!checkTx) isCodeTaken = false;
    }

    const totalAmount = baseAmount + uniqueCode;
    const orderId = `INV-${Date.now()}`;

    await Transaction.create({
      userId,
      orderId,
      planType: planType || "1_month",
      durationDays,
      baseAmount,
      uniqueCode,
      totalAmount
    });

    res.json({
      success: true,
      data: {
        orderId,
        totalAmount,
        uniqueCode,
        bankName: "BNI",
        accountNumber: "1275951171",
        accountHolder: "Muhammad Fajar Firdaus"
      }
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/subscribe/moota-webhook", async (req, res) => {
  try {
    const mootaSecret = process.env.MOOTA_SECRET_TOKEN;
    const incomingSignature = req.headers["signature"] || req.headers["secret-token"];

    if (mootaSecret && incomingSignature !== mootaSecret) {
      return res.status(401).json({ success: false, message: "Unauthorized Signature" });
    }

    const mutations = Array.isArray(req.body) ? req.body : [req.body];

    for (const item of mutations) {
      if (item.type === "CR" || item.type === "credit") {
        const amountReceived = Number(item.amount);

        const tx = await Transaction.findOne({ totalAmount: amountReceived, status: "pending" });

        if (tx) {
          tx.status = "completed";
          await tx.save();

          const user = await User.findById(tx.userId);
          if (user) {
            const now = new Date();
            const durationMs = (tx.durationDays || 30) * 24 * 60 * 60 * 1000;

            let newExpiredAt;
            if (user.plan === "premium" && user.expiredAt && user.expiredAt > now) {
              newExpiredAt = new Date(user.expiredAt.getTime() + durationMs);
            } else {
              newExpiredAt = new Date(now.getTime() + durationMs);
            }

            user.plan = "premium";
            user.expiredAt = newExpiredAt;
            await user.save();

            console.log(`✅ [MOOTA] Pembayaran Rp ${amountReceived} Sukses! User ID ${tx.userId}`);
          }
        }
      }
    }

    res.status(200).json({ status: "success" });

  } catch (err) {
    console.error("❌ Moota Webhook Error:", err.message);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// --- BAILEYS AUTHENTICATION STATE ---
async function useMongoDBAuthState(userId) {
  let session = await Session.findOne({ userId: String(userId) });
  let creds;
  let keys = {};

  if (session && session.data) {
    try {
      const parsed = JSON.parse(session.data, BufferJSON.reviver);
      creds = parsed.creds || initAuthCreds();
      keys = parsed.keys || {};
    } catch {
      creds = initAuthCreds();
    }
  } else {
    creds = initAuthCreds();
  }

  const saveCreds = async () => {
    try {
      const dataStr = JSON.stringify({ creds, keys }, BufferJSON.replacer);
      await Session.findOneAndUpdate({ userId: String(userId) }, { data: dataStr }, { upsert: true });
    } catch (err) {
      console.error(`Error saving creds:`, err.message);
    }
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
    for (const s of sessions) {
      if (!activeSessions.has(String(s.userId)) && !isStartingSession.has(String(s.userId))) {
        startUserBot(String(s.userId));
      }
    }
  } catch (e) {
    console.error("AutoStart Error:", e.message);
  }
}

// --- PEMROSESAN BALASAN AI ---
async function handleAIBotReply(strUserId, senderNumber, remoteJid, combinedText, sock, lastMsgId) {
  try {
    const user = await User.findById(strUserId);
    if (!user) return;

    if (user.isBotActive === false) {
      io.to(strUserId).emit("error-log", {
        time: new Date().toLocaleTimeString(),
        message: "Pesan masuk tetapi Bot dalam status NONAKTIF.",
        from: senderNumber
      });
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    if (user.dailyUsageDate !== today) {
      user.dailyUsageDate = today;
      user.dailyUsageCount = 0;
      await user.save();
    }

    if (user.plan === "free" && user.dailyUsageCount >= 50) {
      io.to(strUserId).emit("error-log", {
        time: new Date().toLocaleTimeString(),
        message: "Batas kuota harian (50 pesan) tercapai.",
        from: senderNumber
      });
      return;
    }

    // Centang biru pesan masuk
    try {
      await sock.readMessages([{ remoteJid, id: lastMsgId }]);
    } catch {}

    let conv = await Conversation.findOne({ botUserId: strUserId, senderNumber });
    if (!conv) {
      conv = await Conversation.create({ botUserId: strUserId, senderNumber, messages: [] });
    }

    conv.messages.push({ role: "user", content: combinedText });

    const historyForAI = conv.messages.slice(-10).map(m => ({
      role: m.role,
      content: m.content
    }));

    const messagesPayload = [
      { role: "system", content: user.systemPrompt || "Kamu adalah asisten AI yang ramah." },
      ...historyForAI
    ];

    const reply = await fetchAIResponse(messagesPayload, strUserId);

    conv.messages.push({ role: "assistant", content: reply });
    await conv.save();

    await sock.sendMessage(remoteJid, { text: reply });
    await User.findByIdAndUpdate(strUserId, { $inc: { dailyUsageCount: 1 } });

    io.to(strUserId).emit("chat-log", {
      time: new Date().toLocaleTimeString(),
      sender: senderNumber,
      text: reply,
      type: "out"
    });

  } catch (err) {
    console.error("❌ Reply Error:", err.message);
    io.to(strUserId).emit("error-log", {
      time: new Date().toLocaleTimeString(),
      message: `Gagal merespon: ${err.message}`,
      from: senderNumber
    });
  }
}

// --- BOT WA ENGINE ---
async function startUserBot(userId) {
  const strUserId = String(userId);

  // Jika sesi sudah berjalan aktif, jangan buat koneksi ganda
  if (activeSessions.has(strUserId)) {
    const activeSock = activeSessions.get(strUserId);
    if (activeSock?.user) {
      io.to(strUserId).emit("status", "Connected");
      return;
    }
  }

  if (isStartingSession.has(strUserId)) return;
  isStartingSession.add(strUserId);

  try {
    const { state, saveCreds } = await useMongoDBAuthState(strUserId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: globalLogger,
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      browser: ["WA AutoBot AI", "Chrome", "1.0.0"],
      getMessage: async () => ({ conversation: "Bot Active" })
    });

    activeSessions.set(strUserId, sock);
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrUrl = await QRCode.toDataURL(qr);
        io.to(strUserId).emit("qr", qrUrl);
        io.to(strUserId).emit("status", "Scan QR Code");
      }

      if (connection === "open") {
        isStartingSession.delete(strUserId);
        console.log(`✅ WA Connected for User: ${strUserId}`);
        io.to(strUserId).emit("status", "Connected");
      }

      if (connection === "close") {
        isStartingSession.delete(strUserId);
        activeSessions.delete(strUserId);

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`🔌 [WA CLOSED] User: ${strUserId} | Reason: ${statusCode} | Reconnect: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(() => startUserBot(strUserId), 4000);
        } else {
          await Session.deleteOne({ userId: strUserId }).catch(() => {});
          io.to(strUserId).emit("status", "Disconnected");
        }
      }
    });

    sock.ev.on("messages.upsert", async (chatUpdate) => {
      try {
        const { messages } = chatUpdate;
        if (!messages || messages.length === 0) return;

        for (const msg of messages) {
          // Abaikan pesan dari diri sendiri, grup, status, atau newsletter
          if (
            !msg.message || 
            msg.key.fromMe || 
            msg.key.remoteJid.endsWith("@g.us") ||
            msg.key.remoteJid === "status@broadcast" ||
            msg.key.remoteJid.endsWith("@newsletter")
          ) continue;

          if (processedMsgIds.has(msg.key.id)) continue;
          processedMsgIds.add(msg.key.id);
          if (processedMsgIds.size > 1000) processedMsgIds.clear();

          const text = extractMessageText(msg);
          if (!text) continue;

          const senderNumber = msg.key.remoteJid.split("@")[0].split(":")[0];

          // LANGSUNG EMIT KE DASHBOARD REALTIME LOG (Pastikan Tampilan Dashboard Selalu Muncul)
          io.to(strUserId).emit("chat-log", {
            time: new Date().toLocaleTimeString(),
            sender: senderNumber,
            text: text,
            type: "in"
          });

          // Aggregation buffer (2 detik) untuk menggabungkan pesan yang dikirim cepat berurutan
          const bufferKey = `${strUserId}_${senderNumber}`;
          if (!messageBuffers.has(bufferKey)) {
            messageBuffers.set(bufferKey, { messages: [], timer: null, remoteJid: msg.key.remoteJid, lastMsgId: msg.key.id });
          }

          const buf = messageBuffers.get(bufferKey);
          buf.messages.push(text);
          buf.remoteJid = msg.key.remoteJid;
          buf.lastMsgId = msg.key.id;

          if (buf.timer) clearTimeout(buf.timer);

          buf.timer = setTimeout(async () => {
            const aggregatedTexts = [...buf.messages];
            const targetJid = buf.remoteJid;
            const targetMsgId = buf.lastMsgId;
            messageBuffers.delete(bufferKey);

            const combinedText = aggregatedTexts.join("\n");
            await handleAIBotReply(strUserId, senderNumber, targetJid, combinedText, sock, targetMsgId);
          }, 2000);
        }
      } catch (err) {
        console.error("Upsert Error:", err.message);
      }
    });

  } catch (error) {
    console.error("Bot Start Error:", error.message);
    isStartingSession.delete(strUserId);
  }
}

// SOCKET.IO REALTIME ROOM MANAGEMENT
io.on("connection", (socket) => {
  socket.on("start-bot", (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const strUserId = String(decoded.userId);
      
      socket.join(strUserId);
      startUserBot(strUserId);
    } catch {
      socket.emit("status", "Unauthorized");
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server ready di port ${PORT}`));
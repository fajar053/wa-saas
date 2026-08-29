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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const resend = new Resend(process.env.RESEND_API_KEY);

// KONFIGURASI TERKUNCI ORCAROUTER & MODEL
const ORCAROUTER_API_KEY = "sk-orca-o4Nup6z4W6q4bJ4PqG56F0O4MWYEoos1WYDYRfJt2mA";
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash-free";

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

// --- HELPER CALL ORCAROUTER API ---
async function fetchAIResponse(messages, strUserId = "", senderNumber = "", timeoutMs = 60000) {
  const apiBaseUrl = "https://api.orcarouter.ai/v1/chat/completions";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(apiBaseUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ORCAROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
        "X-Title": "OrcaRouter Gateway"
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: messages,
        route: "fallback"
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`⚠️ [ORCAROUTER] Model ${DEFAULT_MODEL} Gagal (${response.status}): ${errText}`);
      
      if (strUserId) {
        io.to(strUserId).emit("error-log", {
          time: new Date().toLocaleTimeString(),
          message: `[ORCAROUTER] Model "${DEFAULT_MODEL}" gagal (${response.status}).`,
          from: senderNumber || "Sistem"
        });
      }
      throw new Error(`API Error Status: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (content) {
      console.log(`✅ Respon AI via OrcaRouter: ${DEFAULT_MODEL}`);
      return content;
    }

  } catch (err) {
    console.warn(`⚠️ [ORCAROUTER] Connection Error: ${err.message}`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  throw new Error("Server AI OrcaRouter tidak merespon.");
}

// --- HELPER EKSTRAKSI TEKS PESAN WHATSAPP ---
function extractMessageText(msg) {
  if (!msg.message) return "";
  const m = msg.message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.ephemeralMessage?.message?.conversation ||
    m.ephemeralMessage?.message?.extendedTextMessage?.text ||
    m.viewOnceMessage?.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.buttonsResponseMessage?.selectedButtonId ||
    ""
  );
}

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

    const verifyLink = `${process.env.APP_URL || 'http://localhost:3000'}/api/verify-email?token=${verificationToken}`;
    
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
  const today = new Date().toISOString().split("T")[0];

  if (user.dailyUsageDate !== today) {
    user.dailyUsageDate = today;
    user.dailyUsageCount = 0;
    await user.save();
  }

  res.json({
    email: user.email,
    nickname: user.nickname,
    username: user.username,
    profilePicture: user.profilePicture || `https://api.dicebear.com/7.x/bottts/svg?seed=${user.username}`,
    systemPrompt: user.systemPrompt,
    isBotActive: user.isBotActive ?? true,
    plan: user.plan || "free",
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

// --- FITUR INTEGRASI PEMBAYARAN AUTOMATIS MOOTA (RP 15.000) ---

// 1. ENDPOINT BUAT TAGIHAN TRANSFER + KODE UNIK
app.post("/api/subscribe/create-moota", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const baseAmount = 15000;

    // Cek apakah user sudah punya tagihan pending
    let existingTx = await Transaction.findOne({ userId, status: "pending" });
    if (existingTx) {
      return res.json({
        success: true,
        data: {
          orderId: existingTx.orderId,
          totalAmount: existingTx.totalAmount,
          uniqueCode: existingTx.uniqueCode,
          bankName: "BCA",
          accountNumber: "1234567890", // Silakan sesuaikan nomor rekening
          accountHolder: "Muhammad Fajar Firdaus"
        }
      });
    }

    // Generate 3 digit kode unik acak (100 - 999)
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
        bankName: "BCA",
        accountNumber: "1234567890", // Silakan sesuaikan nomor rekening
        accountHolder: "Muhammad Fajar Firdaus"
      }
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. WEBHOOK RECEIVER DARI MOOTA
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

          await User.findByIdAndUpdate(tx.userId, {
            plan: "premium",
            dailyLimit: "Unlimited"
          });

          console.log(`✅ [MOOTA] Pembayaran Rp ${amountReceived} Sukses! User ID ${tx.userId} diupgrade ke Premium.`);
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
async function handleAIBotReply(strUserId, senderNumber, remoteJid, combinedText, sock) {
  try {
    const user = await User.findById(strUserId);
    if (!user) return;

    if (user.isBotActive === false) {
      console.log(`ℹ️ Bot nonaktif untuk user ${strUserId}`);
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

    let reply = "";

    try {
      reply = await fetchAIResponse(messagesPayload, strUserId, senderNumber);
    } catch {
      conv.messages = [{ role: "user", content: combinedText }];
      reply = await fetchAIResponse([
        { role: "system", content: user.systemPrompt || "Kamu adalah asisten AI yang ramah." },
        { role: "user", content: combinedText }
      ], strUserId, senderNumber);
    }

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

  if (activeSessions.has(strUserId) && activeSessions.get(strUserId)?.ws?.isOpen) {
    io.to(strUserId).emit("status", "Connected");
    return;
  }

  if (isStartingSession.has(strUserId)) return;
  isStartingSession.add(strUserId);

  try {
    if (activeSessions.has(strUserId)) {
      try { activeSessions.get(strUserId)?.end(); } catch {}
      activeSessions.delete(strUserId);
    }

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
        if (statusCode === DisconnectReason.loggedOut) {
          await Session.deleteOne({ userId: strUserId });
          io.to(strUserId).emit("status", "Disconnected");
        } else {
          setTimeout(() => startUserBot(strUserId), 5000);
        }
      }
    });

    sock.ev.on("messages.upsert", async (chatUpdate) => {
      try {
        const { messages, type } = chatUpdate;
        if (type !== "notify") return;

        for (const msg of messages) {
          if (!msg.message || msg.key.fromMe || msg.key.remoteJid.endsWith("@g.us")) continue;

          if (processedMsgIds.has(msg.key.id)) continue;
          processedMsgIds.add(msg.key.id);
          if (processedMsgIds.size > 1000) processedMsgIds.clear();

          const text = extractMessageText(msg);
          if (!text) continue;

          const senderNumber = msg.key.remoteJid.split("@")[0].split(":")[0];

          try {
            await sock.readMessages([{ remoteJid: msg.key.remoteJid, id: msg.key.id, participant: msg.key.participant }]);
          } catch {}

          io.to(strUserId).emit("chat-log", {
            time: new Date().toLocaleTimeString(),
            sender: senderNumber,
            text: text,
            type: "in"
          });

          const bufferKey = `${strUserId}_${senderNumber}`;
          if (!messageBuffers.has(bufferKey)) {
            messageBuffers.set(bufferKey, { messages: [], timer: null, remoteJid: msg.key.remoteJid });
          }

          const buf = messageBuffers.get(bufferKey);
          buf.messages.push(text);
          buf.remoteJid = msg.key.remoteJid;

          if (buf.timer) clearTimeout(buf.timer);

          buf.timer = setTimeout(async () => {
            const aggregatedTexts = [...buf.messages];
            const targetJid = buf.remoteJid;
            messageBuffers.delete(bufferKey);

            const combinedText = aggregatedTexts.join("\n");
            await handleAIBotReply(strUserId, senderNumber, targetJid, combinedText, sock);
          }, 2500);
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
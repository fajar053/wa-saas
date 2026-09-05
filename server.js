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

// Import makeInMemoryStore secara terpisah dari modul internal Baileys
let makeInMemoryStore;
try {
  const storeModule = await import("@whiskeysockets/baileys/lib/Store/index.js");
  makeInMemoryStore = storeModule.default || storeModule.makeInMemoryStore;
} catch (e) {
  // Fallback dummy store jika modul sub-path tidak tersedia pada versi/lingkungan tertentu
  makeInMemoryStore = () => ({
    bind: () => {},
    contacts: {},
    chats: { all: () => [] }
  });
}

import User from "./models/User.js";
import Session from "./models/Session.js";
import Conversation from "./models/Conversation.js";
import Transaction from "./models/Transaction.js";
import Report from "./models/Report.js";
import Schedule from "./models/Schedule.js";

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

// --- MAP UNTUK MENYIMPAN MEMORY STORE SETIAP USER ---
const userStores = new Map();

// --- KONFIGURASI SINGLE PROVIDER: OPENROUTER ENGINE ---
const OPENROUTER_CONFIG = {
  name: "OpenRouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseUrl: process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1/chat/completions",
  models: [
    "inclusionai/ling-3.0-flash",
    "deepseek/deepseek-v4-flash-0731",
    "mistralai/mistral-nemo",
    "meta-llama/llama-3.1-8b-instruct"
  ]
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- HELPER CALL OPENROUTER AI ENGINE ---
async function fetchAIResponse(messages, strUserId = "", timeoutMs = 12000) {
  if (!OPENROUTER_CONFIG.apiKey) {
    console.error("❌ [OPENROUTER ERROR] API Key tidak ditemukan di environment variable OPENROUTER_API_KEY");
    return "Maaf, konfigurasi API Key server belum diatur dengan benar 🙏";
  }

  for (const model of OPENROUTER_CONFIG.models) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    console.log(`📡 [OPENROUTER AI] Requesting model: ${model}`);

    try {
      const response = await fetch(OPENROUTER_CONFIG.baseUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_CONFIG.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "https://wasaas.my.id",
          "X-Title": "WA AutoBot SaaS",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        },
        body: JSON.stringify({
          model: model,
          messages: messages
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if ([400, 401, 403, 404].includes(response.status)) {
        const errJson = await response.json().catch(() => null);
        console.warn(`❌ [OPENROUTER HTTP ${response.status}] ${JSON.stringify(errJson)}`);
        await sleep(300);
        continue;
      }

      if (response.status === 429) {
        console.warn(`⚠️ [RATE LIMIT 429] Model ${model} sibuk, mencoba model cadangan...`);
        await sleep(500);
        continue;
      }

      if (!response.ok) {
        await sleep(300);
        continue;
      }

      const data = await response.json().catch(() => null);
      const content = data?.choices?.[0]?.message?.content;

      if (content && content.trim()) {
        console.log(`✅ [OPENROUTER SUCCESS] Berhasil merespon menggunakan model: ${model}`);
        return content.trim();
      }

    } catch (err) {
      clearTimeout(timeoutId);
      const errDetail = err.cause?.message || err.message;
      console.warn(`⚠️ [OPENROUTER TIMEOUT/ERR] Model ${model}: ${errDetail}`);
      await sleep(300);
    }
  }

  return "Halo! Terima kasih telah menghubungi kami. Saat ini sistem balasan otomatis sedang diproses, mohon ulangi pesan Anda beberapa saat lagi 🙏";
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

// --- MIDDLEWARE AUTO-INJECT SCRIPT STATUS WA KE SEMUA HALAMAN HTML ---
app.use((req, res, next) => {
  if (req.method === "GET" && (req.path.endsWith(".html") || req.path === "/")) {
    const fileName = req.path === "/" ? "index.html" : req.path;
    const filePath = path.join(__dirname, "public", fileName);

    if (fs.existsSync(filePath)) {
      let html = fs.readFileSync(filePath, "utf8");
      
      const scriptsToInject = `
        <script src="/socket.io/socket.io.js"></script>
        <script src="/js/wa-status.js"></script>
        </body>
      `;

      if (html.includes("</body>")) {
        html = html.replace("</body>", scriptsToInject);
      } else {
        html += scriptsToInject;
      }

      return res.send(html);
    }
  }
  next();
});

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

// --- KONFIGURASI MULTER UNTUK KONTEN MEDIA SCHEDULED CHAT ---
const scheduleStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `schedule_${req.user.userId}_${Date.now()}${ext}`);
  }
});

const uploadScheduleMedia = multer({
  storage: scheduleStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
});

// Database Connection & Auto-Assign Admin
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log("✅ DB Connected");

    try {
      await User.updateOne(
        { email: "fajar.stmikplk@gmail.com" },
        { $set: { role: "admin" } }
      );
      console.log("👑 Status Admin untuk fajar.stmikplk@gmail.com berhasil diaktifkan!");
    } catch (err) {
      console.error("⚠️ Gagal update status admin:", err.message);
    }

    autoStartAllSessions();
  })
  .catch(err => console.error("❌ DB Error:", err));

const activeSessions = new Map();
const isStartingSession = new Set();
const processedMsgIds = new Set();
const messageBuffers = new Map();

// --- AUTHENTICATION & MIDDLEWARE ---
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
      isBotActive: true,
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

const verifyAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user || user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Akses ditolak! Khusus administrator." });
    }
    next();
  } catch (err) {
    res.status(403).json({ success: false, message: "Akses terlarang." });
  }
};

app.get("/api/config", verifyToken, async (req, res) => {
  const user = await User.findById(req.user.userId);
  if (!user) return res.status(404).json({ message: "User not found" });

  const today = new Date().toISOString().split("T")[0];
  const currentMonth = today.slice(0, 7);

  if (!user.dailyUsageDate || user.dailyUsageDate.slice(0, 7) !== currentMonth) {
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

  const isBotActive = user.isBotActive !== false && user.isBotActive !== "false";

  res.json({
    email: user.email,
    nickname: user.nickname,
    username: user.username,
    role: user.role || "user",
    profilePicture: user.profilePicture || `https://api.dicebear.com/7.x/bottts/svg?seed=${user.username}`,
    systemPrompt: user.systemPrompt,
    isBotActive: isBotActive,
    plan: user.plan || "free",
    remainingDays: remainingDays,
    dailyUsage: user.dailyUsageCount || 0,
    dailyLimit: user.plan === "premium" ? "Unlimited" : 200
  });
});

app.post("/api/config", verifyToken, async (req, res) => {
  try {
    const { systemPrompt, isBotActive } = req.body;
    const updateFields = {};

    if (systemPrompt !== undefined) {
      updateFields.systemPrompt = systemPrompt;
    }

    if (isBotActive !== undefined) {
      updateFields.isBotActive = Boolean(isBotActive);
    }

    await User.findByIdAndUpdate(
      req.user.userId,
      { $set: updateFields },
      { strict: false, new: true }
    );

    let message = "Pengaturan berhasil disimpan!";
    if (isBotActive !== undefined) {
      message = isBotActive 
        ? "Respon Otomatis Bot telah BERHASIL DIAKTIFKAN!" 
        : "Respon Otomatis Bot telah BERHASIL DINONAKTIFKAN!";
    }

    res.json({ success: true, message });
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

// --- FITUR AUTO GENERATE PROMPT ---
app.post("/api/generate-prompt", verifyToken, async (req, res) => {
  try {
    const { promptText, mode } = req.body;
    const user = await User.findById(req.user.userId);

    if (mode === "very_detailed" && user.plan !== "premium") {
      return res.status(403).json({
        success: false,
        message: "Fitur Auto-Generate 'Sangat Detail (~300 kata)' khusus untuk pengguna Premium."
      });
    }

    const wordTarget = mode === "very_detailed" ? "300" : "50";
    const systemInstruction = `Kamu adalah AI Prompt Engineer profesional. Ubah instruksi singkat berikut menjadi System Prompt WhatsApp dalam Bahasa Indonesia (~${wordTarget} kata). Berikan teks prompt-nya saja tanpa kata pembuka/penutup.`;

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

    let baseAmount = 29000;
    let durationDays = 30;

    if (planType === "6_months") {
      baseAmount = 149000;
      durationDays = 180;
    } else if (planType === "1_year") {
      baseAmount = 259000;
      durationDays = 365;
    }

    let existingTx = await Transaction.findOne({ userId, status: "pending", planType: planType || "1_month" });
    
    if (existingTx) {
      if (existingTx.baseAmount !== baseAmount) {
        await Transaction.deleteOne({ _id: existingTx._id });
        existingTx = null;
      } else {
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
    
    const incomingSignature = 
      req.headers["signature"] || 
      req.headers["secret-token"] || 
      req.headers["x-moota-secret"] ||
      req.headers["authorization"]?.replace("Bearer ", "") ||
      req.body?.secret_token;

    const isTestCheck = !req.body || (Array.isArray(req.body) && req.body.length === 0) || Object.keys(req.body || {}).length === 0;

    if (isTestCheck) {
      console.log("✅ [MOOTA WEBHOOK] Check URL / Ping test berhasil!");
      return res.status(200).json({ status: "success", message: "Webhook URL valid & ready" });
    }

    if (mootaSecret && incomingSignature && incomingSignature !== mootaSecret) {
      console.warn(`⚠️ [MOOTA MISMATCH] Env: "${mootaSecret}" vs Received: "${incomingSignature}"`);
      return res.status(401).json({ success: false, message: "Unauthorized Signature" });
    }

    const mutations = Array.isArray(req.body) ? req.body : [req.body];

    for (const item of mutations) {
      const isCredit = item.type?.toUpperCase() === "CR" || item.type?.toLowerCase() === "credit";
      
      if (isCredit) {
        const amountReceived = Math.round(Number(item.amount));
        console.log(`📩 [MOOTA WEBHOOK] Transaksi Masuk Detected: Rp ${amountReceived}`);

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

            io.to(String(tx.userId)).emit("payment-success", {
              message: "Pembayaran Berhasil! Akun Anda telah di-upgrade ke Premium.",
              plan: user.plan,
              expiredAt: user.expiredAt
            });
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

app.post("/api/subscribe/check-manual", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const tx = await Transaction.findOne({ userId, status: "pending" }).sort({ createdAt: -1 });
    if (!tx) {
      return res.status(404).json({ success: false, message: "Tidak ada transaksi pending yang ditemukan." });
    }

    const mootaApiToken = process.env.MOOTA_API_TOKEN;
    
    if (mootaApiToken) {
      try {
        console.log(`🔍 [MOOTA API SEARCH] Memeriksa mutasi untuk Rp ${tx.totalAmount}...`);
        
        const mootaRes = await fetch(`https://api.moota.co/v1/mutation?amount=${tx.totalAmount}&type=CR`, {
          headers: {
            "Authorization": `Bearer ${mootaApiToken}`,
            "Accept": "application/json"
          }
        });

        if (mootaRes.ok) {
          const mootaData = await mootaRes.json();
          const mutations = mootaData?.data || mootaData || [];

          const match = Array.isArray(mutations) && mutations.some(m => Math.round(Number(m.amount)) === tx.totalAmount);

          if (match) {
            tx.status = "completed";
            await tx.save();

            const user = await User.findById(userId);
            if (user) {
              const now = new Date();
              const durationMs = (tx.durationDays || 30) * 24 * 60 * 60 * 1000;
              user.plan = "premium";
              user.expiredAt = user.expiredAt && user.expiredAt > now 
                ? new Date(user.expiredAt.getTime() + durationMs) 
                : new Date(now.getTime() + durationMs);
              await user.save();
            }

            return res.json({
              success: true,
              completed: true,
              message: "Pembayaran berhasil diverifikasi! Akun Anda kini Aktif Premium."
            });
          }
        }
      } catch (apiErr) {
        console.warn("⚠️ Gagal koneksi Moota API:", apiErr.message);
      }
    }

    res.json({
      success: true,
      completed: false,
      message: "Mutasi belum terdeteksi di server bank/Moota. Mohon tunggu 1-2 menit lagi lalu klik tombol ini kembali."
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- API WA SCHEDULE CHAT DENGAN PEMBACAAN KONTAK & PERCAKAPAN LENGKAP ---
app.get("/api/schedule/targets", verifyToken, async (req, res) => {
  try {
    const strUserId = String(req.user.userId);
    const sock = activeSessions.get(strUserId);

    if (!sock || !sock.user) {
      return res.status(400).json({ success: false, message: "WhatsApp belum terhubung!" });
    }

    const targetsMap = new Map();

    // 1. Ambil Riwayat Percakapan dari DB MongoDB (Sangat Akurat untuk Kontak yang Pernah Chat)
    try {
      const conversations = await Conversation.find({ botUserId: strUserId }).sort({ updatedAt: -1 });
      for (const conv of conversations) {
        const jid = conv.senderNumber.includes("@") ? conv.senderNumber : `${conv.senderNumber}@s.whatsapp.net`;
        const cleanNumber = conv.senderNumber.replace("@s.whatsapp.net", "");
        const formattedName = cleanNumber.startsWith("+") ? cleanNumber : `+${cleanNumber}`;
        
        targetsMap.set(jid, {
          jid,
          name: formattedName,
          type: "contact",
          lastTime: conv.updatedAt ? new Date(conv.updatedAt).getTime() : 0
        });
      }
    } catch (dbErr) {
      console.warn("⚠️ Gagal mengambil riwayat DB:", dbErr.message);
    }

    // 2. Ambil dari Baileys In-Memory Store & Contacts
    const userStore = userStores.get(strUserId) || sock.store;
    if (userStore) {
      if (userStore.contacts) {
        for (const jid in userStore.contacts) {
          if (jid.endsWith("@s.whatsapp.net")) {
            const contact = userStore.contacts[jid];
            const cleanNum = jid.split("@")[0];
            const displayName = contact.name || contact.notify ? `${contact.name || contact.notify} (+${cleanNum})` : `+${cleanNum}`;
            
            if (!targetsMap.has(jid)) {
              targetsMap.set(jid, {
                jid,
                name: displayName,
                type: "contact",
                lastTime: 0
              });
            } else if (contact.name || contact.notify) {
              const existing = targetsMap.get(jid);
              existing.name = `${contact.name || contact.notify} (+${cleanNum})`;
            }
          }
        }
      }

      if (userStore.chats) {
        const chatsList = typeof userStore.chats.all === "function" ? userStore.chats.all() : Object.values(userStore.chats);
        for (const chat of chatsList) {
          if (chat.id && chat.id.endsWith("@s.whatsapp.net") && !targetsMap.has(chat.id)) {
            const cleanNum = chat.id.split("@")[0];
            targetsMap.set(chat.id, {
              jid: chat.id,
              name: chat.name || chat.notify ? `${chat.name || chat.notify} (+${cleanNum})` : `+${cleanNum}`,
              type: "contact",
              lastTime: chat.conversationTimestamp ? chat.conversationTimestamp * 1000 : 0
            });
          }
        }
      }
    }

    // 3. Fetch Grup WA
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const jid in groups) {
        targetsMap.set(jid, {
          jid: jid,
          name: groups[jid].subject || "Grup Tanpa Nama",
          type: "group",
          lastTime: Date.now()
        });
      }
    } catch (err) {
      console.warn("⚠️ Gagal mengambil daftar grup:", err.message);
    }

    // Urutkan Kontak berdasarkan aktivitas percakapan terbaru
    const targets = Array.from(targetsMap.values()).sort((a, b) => b.lastTime - a.lastTime);

    res.json({ success: true, targets });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/schedule/list", verifyToken, async (req, res) => {
  try {
    const schedules = await Schedule.find({ userId: req.user.userId }).sort({ scheduledTime: 1 });
    res.json({ success: true, data: schedules });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/schedule/create", verifyToken, uploadScheduleMedia.single("mediaFile"), async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    const { targetJid, targetName, targetType, message, scheduledTime, isViewOnce } = req.body;

    if (!targetJid || !scheduledTime) {
      return res.status(400).json({ success: false, message: "Target dan waktu kirim wajib diisi!" });
    }

    if (user.plan !== "premium") {
      const pendingCount = await Schedule.countDocuments({ userId: user._id, status: "pending" });
      if (pendingCount >= 2) {
        return res.status(403).json({
          success: false,
          message: "Batas antrian Free Plan (maksimal 2 antrian) tercapai. Upgrade ke Premium untuk antrian unlimited!"
        });
      }

      if (req.file || isViewOnce === "true") {
        return res.status(403).json({
          success: false,
          message: "Fitur kirim media (gambar/video/file) dan Sekali Lihat khusus untuk pengguna Premium!"
        });
      }
    }

    let mediaUrl = "";
    let mediaType = "none";

    if (req.file) {
      mediaUrl = `/uploads/${req.file.filename}`;
      const mime = req.file.mimetype;
      if (mime.startsWith("image/")) mediaType = "image";
      else if (mime.startsWith("video/")) mediaType = "video";
      else mediaType = "document";
    }

    const newSchedule = await Schedule.create({
      userId: user._id,
      targetJid,
      targetName: targetName || targetJid,
      targetType: targetType || "contact",
      message: message || "",
      mediaUrl,
      mediaType,
      isViewOnce: isViewOnce === "true",
      scheduledTime: new Date(scheduledTime),
      status: "pending"
    });

    res.json({ success: true, message: "Jadwal pesan berhasil disimpan!", data: newSchedule });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete("/api/schedule/:id", verifyToken, async (req, res) => {
  try {
    await Schedule.deleteOne({ _id: req.params.id, userId: req.user.userId });
    res.json({ success: true, message: "Jadwal pesan berhasil dihapus!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- WORKER PENJADWAL AUTOMATIS DENGAN PROTEKSI ANTI-SPAM ---
setInterval(async () => {
  try {
    const now = new Date();
    const pendingSchedules = await Schedule.find({
      status: "pending",
      scheduledTime: { $lte: now }
    }).limit(5);

    for (const item of pendingSchedules) {
      const strUserId = String(item.userId);
      const sock = activeSessions.get(strUserId);

      // FIX: Cek kredensial aktif jika sock.user bernilai undefined pada Baileys
      const isConnected = sock && (sock.user || sock.authState?.creds?.me);

      if (!isConnected) {
        console.warn(`⏳ [SCHEDULE DELAY] Session User ${strUserId} belum siap.`);
        continue;
      }

      try {
        console.log(`🚀 [SCHEDULE SENDING] Mengirim pesan otomatis ke ${item.targetJid}...`);

        // Format JID Target
        let targetJid = item.targetJid;
        if (!targetJid.includes("@")) {
          targetJid = `${targetJid}@s.whatsapp.net`;
        }

        // Simulasi Presence (Ketik)
        await sock.sendPresenceUpdate("composing", targetJid).catch(() => {});
        const randomJitter = Math.floor(Math.random() * 2000) + 1000;
        await sleep(randomJitter);
        await sock.sendPresenceUpdate("paused", targetJid).catch(() => {});

        const fullMediaPath = item.mediaUrl ? path.join(__dirname, item.mediaUrl) : null;

        // Eksekusi Kirim Berdasarkan Tipe Media
        if (item.mediaType === "image" && fullMediaPath && fs.existsSync(fullMediaPath)) {
          await sock.sendMessage(targetJid, {
            image: { url: fullMediaPath },
            caption: item.message,
            viewOnce: item.isViewOnce
          });
        } else if (item.mediaType === "video" && fullMediaPath && fs.existsSync(fullMediaPath)) {
          await sock.sendMessage(targetJid, {
            video: { url: fullMediaPath },
            caption: item.message,
            viewOnce: item.isViewOnce
          });
        } else if (item.mediaType === "document" && fullMediaPath && fs.existsSync(fullMediaPath)) {
          await sock.sendMessage(targetJid, {
            document: { url: fullMediaPath },
            fileName: path.basename(fullMediaPath),
            caption: item.message
          });
        } else {
          await sock.sendMessage(targetJid, { text: item.message });
        }

        item.status = "sent";
        await item.save();

        io.to(strUserId).emit("chat-log", {
          time: new Date().toLocaleTimeString(),
          sender: "SCHEDULED BOT",
          text: `[Terkirim ke ${item.targetName}] ${item.message}`,
          type: "out"
        });

        console.log(`✅ [SCHEDULE SUCCESS] Pesan berhasil terkirim ke ${item.targetName}`);

      } catch (sendErr) {
        console.error(`❌ [SCHEDULE ERR]:`, sendErr.message);
        item.status = "failed";
        item.errorMessage = sendErr.message;
        await item.save();
      }

      await sleep(3000);
    }
  } catch (cronErr) {
    console.error("Scheduler Worker Error:", cronErr.message);
  }
}, 10000);

// --- USER REPORT API ---
app.post("/api/reports", verifyToken, async (req, res) => {
  try {
    const { category, subject, message } = req.body;
    const user = await User.findById(req.user.userId);
    
    if (!category || !subject || !message) {
      return res.status(400).json({ success: false, message: "Semua kolom laporan wajib diisi." });
    }

    const reportId = `RPT-${Math.floor(10000 + Math.random() * 90000)}`;

    const newReport = await Report.create({
      reportId,
      userId: user._id,
      userEmail: user.email,
      userNickname: user.nickname,
      category,
      subject,
      message
    });

    res.json({ success: true, message: `Laporan berhasil dikirim! ID Laporan: ${reportId}`, data: newReport });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/reports/my-reports", verifyToken, async (req, res) => {
  try {
    const reports = await Report.find({ userId: req.user.userId }).sort({ createdAt: -1 });
    res.json({ success: true, data: reports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- ADMIN API ---
app.get("/api/admin/pending-payments", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const transactions = await Transaction.find({ status: "pending" }).populate("userId", "nickname email").sort({ createdAt: -1 });
    res.json({ success: true, data: transactions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/admin/approve-payment", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { transactionId } = req.body;
    const tx = await Transaction.findById(transactionId);
    if (!tx) return res.status(404).json({ success: false, message: "Transaksi tidak ditemukan" });

    tx.status = "completed";
    await tx.save();

    const user = await User.findById(tx.userId);
    if (user) {
      const now = new Date();
      const durationMs = (tx.durationDays || 30) * 24 * 60 * 60 * 1000;
      user.plan = "premium";
      user.expiredAt = user.expiredAt && user.expiredAt > now 
        ? new Date(user.expiredAt.getTime() + durationMs) 
        : new Date(now.getTime() + durationMs);
      await user.save();

      io.to(String(user._id)).emit("payment-success", {
        message: "Pembayaran Anda telah disetujui secara manual oleh Admin!",
        plan: user.plan,
        expiredAt: user.expiredAt
      });
    }

    res.json({ success: true, message: "Pembayaran berhasil dikonfirmasi & status User telah di-upgrade ke Premium!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/admin/all-reports", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const reports = await Report.find().sort({ createdAt: -1 });
    res.json({ success: true, data: reports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/admin/reply-report", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { reportId, adminReply, status } = req.body;
    const report = await Report.findOne({ reportId });
    if (!report) return res.status(404).json({ success: false, message: "Laporan tidak ditemukan" });

    report.adminReply = adminReply;
    report.status = status || "Resolved";
    report.repliedAt = new Date();
    await report.save();

    res.json({ success: true, message: "Tanggapan berhasil dikirim ke User!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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

// --- HELPER SIMULASI KIRIM BALASAN HUMANIS / ANTI-BLOKIR ---
async function sendHumanizedReply(sock, remoteJid, replyText, imageUrl = null) {
  try {
    await sock.sendPresenceUpdate("composing", remoteJid);

    const baseDelay = Math.min(Math.max((replyText || "").length * 35, 2000), 6000);
    const randomJitter = Math.floor(Math.random() * 1200);
    const totalTypingTime = baseDelay + randomJitter;

    await sleep(totalTypingTime);

    await sock.sendPresenceUpdate("paused", remoteJid);
    await sleep(300);

    if (imageUrl) {
      await sock.sendMessage(remoteJid, {
        image: { url: imageUrl },
        caption: replyText || ""
      });
    } else if (replyText) {
      await sock.sendMessage(remoteJid, { text: replyText });
    }
  } catch (err) {
    console.warn("⚠️ Anti-Ban Send Fallback:", err.message);
    if (imageUrl) {
      await sock.sendMessage(remoteJid, { image: { url: imageUrl }, caption: replyText || "" });
    } else if (replyText) {
      await sock.sendMessage(remoteJid, { text: replyText });
    }
  }
}

// --- PEMROSESAN BALASAN AI ---
async function handleAIBotReply(strUserId, senderNumber, remoteJid, combinedText, sock, lastMsgId) {
  try {
    const user = await User.findById(strUserId);
    if (!user) return;

    if (user.isBotActive === false || user.isBotActive === "false") {
      console.log(`⏸️ [BOT NONAKTIF] User ${strUserId} mematikan respon otomatis.`);
      io.to(strUserId).emit("chat-log", {
        time: new Date().toLocaleTimeString(),
        sender: senderNumber,
        text: `[Pesan Masuk (Bot Off)]: ${combinedText}`,
        type: "in"
      });
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    const currentMonth = today.slice(0, 7);

    if (!user.dailyUsageDate || user.dailyUsageDate.slice(0, 7) !== currentMonth) {
      user.dailyUsageDate = today;
      user.dailyUsageCount = 0;
      await user.save();
    }

    if (user.plan === "free" && user.dailyUsageCount >= 200) {
      io.to(strUserId).emit("error-log", {
        time: new Date().toLocaleTimeString(),
        message: "Batas kuota bulanan (200 pesan) tercapai. Silakan upgrade ke Premium!",
        from: senderNumber
      });
      return;
    }

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

    await sendHumanizedReply(sock, remoteJid, reply);
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

    // Inisialisasi In-Memory Store Baileys
    let store = userStores.get(strUserId);
    if (!store) {
      store = makeInMemoryStore({ logger: globalLogger });
      userStores.set(strUserId, store);
    }

    const sock = makeWASocket({
      version,
      logger: globalLogger,
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      browser: ["Ubuntu", "Chrome", "122.0.6261.111"],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      getMessage: async () => ({ conversation: "Bot Active" })
    });

    if (store && typeof store.bind === "function") {
      store.bind(sock.ev);
    }
    sock.store = store;

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
          setTimeout(() => startUserBot(strUserId), 5000);
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

          io.to(strUserId).emit("chat-log", {
            time: new Date().toLocaleTimeString(),
            sender: senderNumber,
            text: text,
            type: "in"
          });

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
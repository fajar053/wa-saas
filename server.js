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
import midtransClient from "midtrans-client";
import makeWASocket, { 
  DisconnectReason, 
  fetchLatestBaileysVersion, 
  initAuthCreds, 
  BufferJSON
} from "@whiskeysockets/baileys";
import pino from "pino";

let makeInMemoryStore;
try {
  const storeModule = await import("@whiskeysockets/baileys/lib/Store/index.js");
  makeInMemoryStore = storeModule.default || storeModule.makeInMemoryStore;
} catch (e) {
  makeInMemoryStore = () => ({
    bind: () => {},
    contacts: {},
    chats: { all: () => [] },
    loadMessage: async () => null
  });
}

import User from "./models/User.js";
import Session from "./models/Session.js";
import Conversation from "./models/Conversation.js";
import Schedule from "./models/Schedule.js";
import Transaction from "./models/Transaction.js";
import Report from "./models/Report.js";
import Product from "./models/Product.js";
import { appendChatToSheet, appendProductToSheet } from "./services/googleSheetService.js";

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

const isMidtransProd = Boolean(
  process.env.MIDTRANS_SERVER_KEY && !process.env.MIDTRANS_SERVER_KEY.startsWith("SB-")
);

const snap = new midtransClient.Snap({
  isProduction: isMidtransProd,
  serverKey: process.env.MIDTRANS_SERVER_KEY || "",
  clientKey: process.env.MIDTRANS_CLIENT_KEY || ""
});

const userStores = new Map();
const senderRateLimits = new Map();

function calculateExpiryDate(planType) {
  const now = new Date();
  let days = 30;
  if (planType === "6_month") days = 180;
  if (planType === "1_year") days = 365;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

if (!fs.existsSync(path.join(__dirname, "uploads"))) {
  fs.mkdirSync(path.join(__dirname, "uploads"));
}

const productStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `prod_${req.user.userId}_${Date.now()}${ext}`);
  }
});

const uploadProductMedia = multer({
  storage: productStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

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

const proofStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `proof_${req.user.userId}_${Date.now()}${ext}`);
  }
});

const uploadPaymentProof = multer({
  storage: proofStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

function normalizeJid(rawJid) {
  if (!rawJid) return "";
  let jid = String(rawJid).trim();

  if (jid.includes(":")) {
    const parts = jid.split("@");
    const cleanUser = parts[0].split(":")[0];
    jid = `${cleanUser}@${parts[1]}`;
  }

  if (jid.endsWith("@lid") || jid.endsWith("@g.us") || jid.endsWith("@newsletter")) {
    return jid;
  }

  let cleanNum = jid.split("@")[0].replace(/[^0-9]/g, "");
  if (cleanNum.startsWith("0")) {
    cleanNum = "62" + cleanNum.slice(1);
  } else if (cleanNum.startsWith("8")) {
    cleanNum = "62" + cleanNum;
  }

  return `${cleanNum}@s.whatsapp.net`;
}

function extractPhoneNumber(rawJid) {
  if (!rawJid) return "";
  const clean = String(rawJid).split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
  return clean || rawJid;
}

function resolveTargetJids(msg) {
  const jids = [];
  if (!msg || !msg.key) return jids;

  const remoteJid = msg.key.remoteJid || "";
  const remoteJidAlt = msg.key.remoteJidAlt || "";
  const participant = msg.key.participant || "";

  if (remoteJidAlt && remoteJidAlt.endsWith("@s.whatsapp.net")) {
    jids.push(normalizeJid(remoteJidAlt));
  }
  if (participant && participant.endsWith("@s.whatsapp.net")) {
    jids.push(normalizeJid(participant));
  }
  if (remoteJid.endsWith("@s.whatsapp.net")) {
    jids.push(normalizeJid(remoteJid));
  }

  const cleanNum = extractPhoneNumber(remoteJid);
  if (cleanNum && cleanNum.length >= 7) {
    const phoneJid = `${cleanNum}@s.whatsapp.net`;
    if (!jids.includes(phoneJid)) jids.push(phoneJid);
  }

  if (remoteJid.endsWith("@lid") && !jids.includes(remoteJid)) {
    jids.push(remoteJid);
  }

  return jids;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isSenderRateLimited(senderNumber) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxAllowed = 8;

  if (!senderRateLimits.has(senderNumber)) {
    senderRateLimits.set(senderNumber, []);
  }

  const timestamps = senderRateLimits.get(senderNumber).filter(ts => now - ts < windowMs);
  timestamps.push(now);
  senderRateLimits.set(senderNumber, timestamps);

  return timestamps.length > maxAllowed;
}

const OPENROUTER_CONFIG = {
  name: "OpenRouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseUrl: process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1/chat/completions",
  freeModels: [
    "nvidia/nemotron-3.5-lightning:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    "nvidia/nemotron-3.5-content-safety:free",
    "cohere/north-mini-code:free",
    "dots-studio/dots-3-note-preview:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "inclusionai/ling-3.0-flash-fin:free",
    "inclusionai/ling-3.0-flash-sante:free",
    "minimax/minimax-m2.7:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "openrouter/free"
  ],
  premiumModels: [
    "inclusionai/ling-3.0-flash",
    "deepseek/deepseek-v4-flash-0731",
    "mistralai/mistral-nemo",
    "meta-llama/llama-3.1-8b-instruct"
  ]
};

async function fetchFreeAIResponse(messages) {
  if (!OPENROUTER_CONFIG.apiKey) {
    console.error("❌ [OPENROUTER FREE] API Key tidak ditemukan!");
    return "Maaf, konfigurasi API Key server belum diatur dengan benar 🙏";
  }

  for (const model of OPENROUTER_CONFIG.freeModels) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    try {
      console.log(`📡 [AI FREE ENGINE] Memanggil model: ${model}`);
      const response = await fetch(OPENROUTER_CONFIG.baseUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_CONFIG.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "https://wasaas.my.id",
          "X-Title": "WA AutoBot SaaS",
          "User-Agent": "Mozilla/5.0"
        },
        body: JSON.stringify({ model, messages }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`⚠️ [AI FREE ERROR] Model ${model} status HTTP ${response.status}. Langsung ganti model...`);
        continue;
      }

      const data = await response.json().catch(() => null);
      const content = data?.choices?.[0]?.message?.content;

      if (content && content.trim()) {
        console.log(`✅ [AI FREE SUCCESS] Berhasil direspon oleh: ${model}`);
        return content.trim();
      }

    } catch (err) {
      clearTimeout(timeoutId);
      console.warn(`⚠️ [AI FREE FAIL/TIMEOUT] Model ${model} (${err.message}). Langsung ganti model berikutnya...`);
    }
  }

  return "Halo! Terima kasih telah menghubungi kami. Mohon ulangi pesan Anda beberapa saat lagi 🙏";
}

async function fetchPremiumAIResponse(messages) {
  if (!OPENROUTER_CONFIG.apiKey) {
    console.error("❌ [OPENROUTER PREMIUM] API Key tidak ditemukan!");
    return "Maaf, konfigurasi API Key server belum diatur dengan benar 🙏";
  }

  for (const model of OPENROUTER_CONFIG.premiumModels) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    try {
      console.log(`📡 [AI PREMIUM ENGINE] Memanggil model: ${model}`);
      const response = await fetch(OPENROUTER_CONFIG.baseUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_CONFIG.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "https://wasaas.my.id",
          "X-Title": "WA AutoBot SaaS",
          "User-Agent": "Mozilla/5.0"
        },
        body: JSON.stringify({ model, messages }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`⚠️ [AI PREMIUM ERROR] Model ${model} status HTTP ${response.status}. Ganti model...`);
        continue;
      }

      const data = await response.json().catch(() => null);
      const content = data?.choices?.[0]?.message?.content;

      if (content && content.trim()) {
        console.log(`✅ [AI PREMIUM SUCCESS] Berhasil direspon oleh: ${model}`);
        return content.trim();
      }

    } catch (err) {
      clearTimeout(timeoutId);
      console.warn(`⚠️ [AI PREMIUM FAIL/TIMEOUT] Model ${model} (${err.message}). Ganti model berikutnya...`);
    }
  }

  return "Halo! Terima kasih telah menghubungi kami. Mohon ulangi pesan Anda beberapa saat lagi 🙏";
}

async function fetchAIResponse(messages, plan = "free") {
  if (plan === "premium") {
    return await fetchPremiumAIResponse(messages);
  }
  return await fetchFreeAIResponse(messages);
}

function extractMessageText(msg) {
  if (!msg || !msg.message) return "";
  let m = msg.message;

  if (m.ephemeralMessage) m = m.ephemeralMessage.message || m;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message || m;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message || m;

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  ).trim();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use((req, res, next) => {
  if (req.method === "GET" && (req.path.endsWith(".html") || req.path === "/")) {
    const fileName = req.path === "/" ? "index.html" : req.path;
    const filePath = path.join(__dirname, "public", fileName);

    if (fs.existsSync(filePath)) {
      let html = fs.readFileSync(filePath, "utf8");
      const scriptsToInject = `
        <script src="/socket.io/socket.io.js"></script>
        </body>
      `;

      html = html.includes("</body>") ? html.replace("</body>", scriptsToInject) : html + scriptsToInject;
      return res.send(html);
    }
  }
  next();
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log("✅ DB Connected");
    autoStartAllSessions();
  })
  .catch(err => console.error("❌ DB Error:", err));

const activeSessions = new Map();
const isStartingSession = new Set();
const processedMsgIds = new Set();
const messageBuffers = new Map();

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Unauthorized" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: "Token Invalid / Expired" });
  }
};

const verifyAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user || user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Akses Ditolak! Hanya untuk Administrator." });
    }
    next();
  } catch {
    res.status(500).json({ success: false, message: "Terjadi kesalahan autentikasi admin." });
  }
};

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
    if (!user) return res.send("<h2>Token tidak valid / expired.</h2>");

    user.isVerified = true;
    user.verificationToken = null;
    await user.save();

    const loginToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "1h" });
    res.send(`
      <script>
        localStorage.setItem('token', '${loginToken}');
        window.location.href = '/dashboard.html';
      </script>
      <h2>Verifikasi Berhasil! Mengalihkan...</h2>
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

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: "1h" });
    res.json({ success: true, token, user });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/api/config", verifyToken, async (req, res) => {
  const user = await User.findById(req.user.userId);
  if (!user) return res.status(404).json({ message: "User not found" });

  if (user.plan === "premium" && user.premiumExpiresAt && new Date() > new Date(user.premiumExpiresAt)) {
    user.plan = "free";
    user.premiumExpiresAt = null;
    await user.save();
  }

  res.json({
    email: user.email,
    nickname: user.nickname,
    username: user.username,
    role: user.role || "user",
    profilePicture: user.profilePicture || `https://api.dicebear.com/7.x/bottts/svg?seed=${user.username}`,
    systemPrompt: user.systemPrompt,
    isBotActive: user.isBotActive !== false,
    plan: user.plan || "free",
    premiumExpiresAt: user.premiumExpiresAt || null,
    dailyUsage: user.dailyUsageCount || 0,
    dailyLimit: user.plan === "premium" ? "Unlimited" : 200,
    midtransClientKey: process.env.MIDTRANS_CLIENT_KEY || "",
    isMidtransProd
  });
});

app.post("/api/config", verifyToken, async (req, res) => {
  try {
    const { systemPrompt, isBotActive } = req.body;
    const updateFields = {};
    if (systemPrompt !== undefined) updateFields.systemPrompt = systemPrompt;
    if (isBotActive !== undefined) updateFields.isBotActive = Boolean(isBotActive);

    await User.findByIdAndUpdate(req.user.userId, { $set: updateFields });
    res.json({ success: true, message: "Pengaturan berhasil disimpan!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/products", verifyToken, async (req, res) => {
  try {
    const products = await Product.find({ userId: req.user.userId }).sort({ createdAt: -1 });
    res.json({ success: true, data: products });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/products", verifyToken, uploadProductMedia.single("imageFile"), async (req, res) => {
  try {
    const { name, price, description } = req.body;
    if (!name || !price) {
      return res.status(400).json({ success: false, message: "Nama dan Harga produk wajib diisi!" });
    }

    const user = await User.findById(req.user.userId);
    let imageUrl = "";

    if (req.file) {
      imageUrl = `/uploads/${req.file.filename}`;
    }

    const newProduct = await Product.create({
      userId: req.user.userId,
      name,
      price: Number(price),
      description: description || "",
      imageUrl
    });

    if (user.googleRefreshToken && user.googleSpreadsheetId) {
      appendProductToSheet(user.googleRefreshToken, user.googleSpreadsheetId, {
        name,
        price: Number(price),
        description: description || "",
        imageUrl: imageUrl ? `${process.env.APP_URL || 'https://wasaas.my.id'}${imageUrl}` : '-'
      }).catch(() => {});
    }

    res.json({ success: true, message: "Produk berhasil ditambahkan!", data: newProduct });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete("/api/products/:id", verifyToken, async (req, res) => {
  try {
    await Product.deleteOne({ _id: req.params.id, userId: req.user.userId });
    res.json({ success: true, message: "Produk berhasil dihapus!" });
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

app.post("/api/generate-prompt", verifyToken, async (req, res) => {
  try {
    const { promptText, mode } = req.body;
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ success: false, message: "User tidak ditemukan!" });

    const targetWords = parseInt(mode) || 50;

    if (targetWords > 50 && user.plan !== "premium") {
      return res.status(403).json({
        success: false,
        message: "Fitur Auto-Generate di atas 50 kata khusus untuk pengguna Premium."
      });
    }

    const systemInstruction = `Kamu adalah AI Prompt Engineer profesional. Ubah instruksi singkat berikut menjadi System Prompt instruksi WhatsApp Bot yang terstruktur dan detail dalam Bahasa Indonesia (~${targetWords} kata). Berikan teks prompt-nya saja secara langsung tanpa kata pembuka atau penutup.`;

    const messages = [
      { role: "system", content: systemInstruction },
      { role: "user", content: promptText }
    ];

    const generatedPrompt = await fetchAIResponse(messages, user.plan || "free");
    res.json({ success: true, generatedPrompt });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/payment/mayar-create", verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ success: false, message: "User tidak ditemukan!" });

    const { planType, amount, planTitle } = req.body;

    if (!process.env.MAYAR_API_KEY) {
      return res.status(500).json({ success: false, message: "API Key Mayar belum diatur di server!" });
    }

    const response = await fetch("https://api.mayar.id/hl/v1/payment/create", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.MAYAR_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: user.nickname || user.username,
        email: user.email,
        amount: Number(amount),
        description: `Upgrade Paket ${planTitle}`,
        redirectUrl: `${process.env.APP_URL || 'https://wasaas.my.id'}/subscription.html?status=success`
      })
    });

    const result = await response.json();

    if (!response.ok || !result.data?.link) {
      return res.status(400).json({ 
        success: false, 
        message: result.message || "Gagal membuat link pembayaran Mayar." 
      });
    }

    const orderId = result.data.id || `MAYAR-${user._id.toString().slice(-5)}-${Date.now()}`;
    await Transaction.create({
      userId: user._id,
      orderId,
      planType,
      amount: Number(amount),
      status: "pending"
    });

    res.json({
      success: true,
      paymentUrl: result.data.link
    });

  } catch (err) {
    console.error("❌ Mayar Payment Create Error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/mayar/webhook", async (req, res) => {
  try {
    const { event, data } = req.body;
    console.log(`🔔 [MAYAR WEBHOOK INCOMING] Event: ${event}, Data Status: ${data?.status}`);

    const isSuccess = 
      event === "payment.received" || 
      data?.status === "SUCCESS" || 
      data?.status === "PAID";

    if (isSuccess) {
      const customerEmail = (
        data?.customerEmail || 
        data?.customer?.email || 
        data?.email || 
        ""
      ).trim();

      const paymentId = data?.id || data?.transactionId;

      console.log(`🔍 [MAYAR WEBHOOK] Processing Email: '${customerEmail}', Payment ID: '${paymentId}'`);

      let isUpgraded = false;

      if (paymentId) {
        const tx = await Transaction.findOne({ orderId: paymentId });
        if (tx) {
          tx.status = "success";
          await tx.save();
          const expiresAt = calculateExpiryDate(tx.planType);
          await User.findByIdAndUpdate(tx.userId, { plan: "premium", premiumExpiresAt: expiresAt });
          console.log(`✅ [MAYAR WEBHOOK SUCCESS] User ID ${tx.userId} berhasil di-upgrade ke PREMIUM sampai ${expiresAt}!`);
          isUpgraded = true;
        }
      }

      if (!isUpgraded && customerEmail) {
        const user = await User.findOne({ 
          email: { $regex: new RegExp(`^${customerEmail}$`, "i") } 
        });

        if (user) {
          const expiresAt = calculateExpiryDate("1_month");
          user.plan = "premium";
          user.premiumExpiresAt = expiresAt;
          await user.save();
          console.log(`✅ [MAYAR WEBHOOK SUCCESS] User ${user.email} (${user._id}) berhasil di-upgrade ke PREMIUM via Match Email!`);
          isUpgraded = true;
        } else {
          console.warn(`⚠️ [MAYAR WEBHOOK WARN] User dengan email '${customerEmail}' tidak ditemukan di database.`);
        }
      }

      if (!isUpgraded) {
        console.warn(`⚠️ [MAYAR WEBHOOK WARN] Gagal mencocokkan transaksi dengan Order ID maupun Email.`);
      }
    }

    res.status(200).json({ success: true, message: "Webhook berhasil diproses" });
  } catch (err) {
    console.error("❌ Mayar Webhook Error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/payment/manual-submit", verifyToken, uploadPaymentProof.single("proofFile"), async (req, res) => {
  try {
    const strUserId = String(req.user.userId);
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ success: false, message: "User tidak ditemukan!" });

    const { planType, paymentMethod, amount } = req.body;

    if (!req.file) {
      return res.status(400).json({ success: false, message: "Bukti pembayaran wajib diunggah!" });
    }

    const sock = activeSessions.get(strUserId);

    if (!sock || !sock.user) {
      return res.status(400).json({
        success: false,
        waConnected: false,
        message: "WhatsApp belum terhubung! Silakan scan QR Code yang muncul di pop-up."
      });
    }

    const adminJid = "6285183099618@s.whatsapp.net";
    const fullProofPath = path.join(__dirname, req.file.path);

    const captionMessage = 
`📌 *KONFIRMASI PEMBAYARAN MANUAL*

👤 *Nama*: ${user.nickname || user.username}
✉️ *Email*: ${user.email}
📦 *Paket*: ${planType.replace('_', ' ').toUpperCase()}
💰 *Total Tagihan*: Rp ${Number(amount).toLocaleString('id-ID')}
💳 *Metode Pembayaran*: ${paymentMethod}
📅 *Waktu Kirim*: ${new Date().toLocaleString('id-ID')}

Mohon verifikasi bukti pembayaran terlampir. Terima kasih!`;

    console.log(`📤 [MANUAL PAYMENT] Mengirim bukti bayar dari ${user.email} ke admin (+6285183099618)...`);

    await sock.sendMessage(adminJid, {
      image: { url: fullProofPath },
      caption: captionMessage
    });

    const orderId = `MANUAL-${user._id.toString().slice(-5)}-${Date.now()}`;
    await Transaction.create({
      userId: user._id,
      orderId,
      planType,
      amount: Number(amount),
      status: "pending_manual"
    });

    console.log(`✅ [MANUAL PAYMENT SUCCESS] Bukti bayar ${orderId} terkirim via WA.`);

    res.json({
      success: true,
      waConnected: true,
      message: "Bukti pembayaran berhasil dikirimkan ke Admin via WhatsApp!"
    });

  } catch (err) {
    console.error("❌ Manual Payment Error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/reports", verifyToken, async (req, res) => {
  try {
    const { category, subject, message } = req.body;
    if (!category || !subject || !message) {
      return res.status(400).json({ success: false, message: "Semua field laporan wajib diisi!" });
    }

    const reportId = `RPT-${req.user.userId.toString().slice(-4)}-${Date.now().toString().slice(-5)}`;

    const newReport = await Report.create({
      userId: req.user.userId,
      reportId,
      category,
      subject,
      message
    });

    res.json({
      success: true,
      message: "Laporan kendala berhasil dikirimkan ke Tim Support!",
      data: newReport
    });
  } catch (err) {
    console.error("❌ Create Report Error:", err.message);
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

app.get("/api/admin/all-reports", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const reports = await Report.find().sort({ createdAt: -1 }).populate("userId", "nickname username email");
    
    const formattedReports = reports.map(rpt => {
      const u = rpt.userId || {};
      return {
        _id: rpt._id,
        reportId: rpt.reportId,
        userNickname: u.nickname || u.username || "User",
        userEmail: u.email || "-",
        category: rpt.category,
        subject: rpt.subject,
        message: rpt.message,
        status: rpt.status,
        adminReply: rpt.adminReply,
        createdAt: rpt.createdAt
      };
    });

    res.json({ success: true, data: formattedReports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/admin/reply-report", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { reportId, adminReply, status } = req.body;
    if (!reportId || !adminReply) {
      return res.status(400).json({ success: false, message: "ID Laporan dan pesan balasan wajib diisi!" });
    }

    const report = await Report.findOne({ reportId });
    if (!report) {
      return res.status(404).json({ success: false, message: "Laporan tidak ditemukan!" });
    }

    report.adminReply = adminReply;
    report.status = status || "Resolved";
    report.repliedAt = new Date();
    await report.save();

    res.json({ success: true, message: "Balasan laporan berhasil dikirim ke user!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete("/api/admin/report/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    await Report.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Laporan berhasil dihapus secara permanen!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/admin/pending-payments", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const pendingTxs = await Transaction.find({ status: { $in: ["pending", "pending_manual"] } })
      .sort({ createdAt: -1 })
      .populate("userId", "nickname username email");

    res.json({ success: true, data: pendingTxs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/admin/approve-payment", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { transactionId } = req.body;
    const tx = await Transaction.findById(transactionId);

    if (!tx) {
      return res.status(404).json({ success: false, message: "Transaksi tidak ditemukan!" });
    }

    tx.status = "success";
    await tx.save();

    const expiresAt = calculateExpiryDate(tx.planType);
    await User.findByIdAndUpdate(tx.userId, { plan: "premium", premiumExpiresAt: expiresAt });

    res.json({ success: true, message: `Pembayaran disetujui! Status akun user di-upgrade ke Premium (s/d ${expiresAt.toLocaleString('id-ID')}).` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete("/api/admin/transaction/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    await Transaction.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Data transaksi berhasil dihapus secara permanen!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/analytics/stats", verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const user = await User.findById(userId);

    if (!user) return res.status(404).json({ success: false, message: "User tidak ditemukan" });

    const totalSchedules = await Schedule.countDocuments({ userId });
    const sentSchedules = await Schedule.countDocuments({ userId, status: "sent" });
    const pendingSchedules = await Schedule.countDocuments({ userId, status: "pending" });
    const failedSchedules = await Schedule.countDocuments({ userId, status: "failed" });

    const schedSuccessRate = totalSchedules > 0 
      ? ((sentSchedules / (totalSchedules - pendingSchedules || 1)) * 100).toFixed(1) 
      : "100";

    const conversations = await Conversation.find({ botUserId: String(userId) });
    let totalMessagesCount = 0;

    conversations.forEach(c => {
      totalMessagesCount += (c.messages || []).length;
    });

    const days = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];
    const trafficSent = [12, 19, 15, 25, 22, 30, user.dailyUsageCount || 10];
    const trafficReceived = [14, 21, 17, 28, 24, 32, (user.dailyUsageCount || 10) + 3];

    const accuracyData = {
      success: Math.max(Math.floor(totalMessagesCount * 0.95), user.dailyUsageCount || 0),
      escalated: Math.floor(totalMessagesCount * 0.04),
      failed: failedSchedules
    };

    res.json({
      success: true,
      data: {
        avgLatency: "1.8s - 2.4s",
        accuracyRate: 97.5,
        scheduleSuccessRate: schedSuccessRate,
        totalMessages: user.dailyUsageCount || totalMessagesCount,
        quotaLimit: user.plan === "premium" ? "Unlimited" : "200 / Hari",
        schedules: {
          total: totalSchedules,
          sent: sentSchedules,
          pending: pendingSchedules,
          failed: failedSchedules
        },
        accuracy: accuracyData,
        traffic: {
          labels: days,
          sent: trafficSent,
          received: trafficReceived
        }
      }
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/schedule/targets", verifyToken, async (req, res) => {
  try {
    const strUserId = String(req.user.userId);
    const sock = activeSessions.get(strUserId);

    if (!sock) {
      return res.status(400).json({ success: false, message: "WhatsApp belum terhubung!" });
    }

    const targetsMap = new Map();

    try {
      const conversations = await Conversation.find({ botUserId: strUserId }).sort({ updatedAt: -1 });
      for (const conv of conversations) {
        const jid = normalizeJid(conv.senderNumber);
        const cleanNum = extractPhoneNumber(jid);
        targetsMap.set(jid, {
          jid,
          name: `+${cleanNum}`,
          type: "contact",
          lastTime: conv.updatedAt ? new Date(conv.updatedAt).getTime() : 0
        });
      }
    } catch (err) {}

    const userStore = userStores.get(strUserId) || sock.store;
    if (userStore && userStore.contacts) {
      for (const rawJid in userStore.contacts) {
        if (rawJid.endsWith("@s.whatsapp.net") || rawJid.endsWith("@lid")) {
          const contact = userStore.contacts[rawJid];
          const jid = normalizeJid(rawJid);
          const cleanNum = extractPhoneNumber(jid);
          const displayName = contact.name || contact.notify ? `${contact.name || contact.notify} (+${cleanNum})` : `+${cleanNum}`;
          
          if (!targetsMap.has(jid)) {
            targetsMap.set(jid, { jid, name: displayName, type: "contact", lastTime: 0 });
          }
        }
      }
    }

    try {
      const groups = await sock.groupFetchAllParticipating().catch(() => ({}));
      for (const jid in groups) {
        targetsMap.set(jid, {
          jid: jid,
          name: groups[jid].subject || "Grup Tanpa Nama",
          type: "group",
          lastTime: Date.now()
        });
      }
    } catch (err) {}

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
    if (!user) return res.status(404).json({ success: false, message: "User tidak ditemukan!" });

    let { targetJid, targetName, targetType, message, scheduledTime, isViewOnce } = req.body;

    if (!targetJid || !scheduledTime) {
      return res.status(400).json({ success: false, message: "Target dan waktu kirim wajib diisi!" });
    }

    const isPremium = user.plan === "premium";
    const now = new Date();
    const schedDate = new Date(scheduledTime);

    if (schedDate <= now) {
      return res.status(400).json({ success: false, message: "Waktu kirim harus di masa mendatang!" });
    }

    const pendingCount = await Schedule.countDocuments({ userId: user._id, status: "pending" });
    const maxPending = isPremium ? 10 : 2;

    if (pendingCount >= maxPending) {
      return res.status(403).json({
        success: false,
        message: isPremium
          ? "Batas maksimal 10 antrian jadwal pending tercapai!"
          : "🔒 Pengguna Free Plan hanya dapat membuat maksimal 2 antrian jadwal pending. Silakan upgrade ke Premium!"
      });
    }

    const maxDays = isPremium ? 30 : 7;
    const maxAllowedDate = new Date(now.getTime() + maxDays * 24 * 60 * 60 * 1000);

    if (schedDate > maxAllowedDate) {
      return res.status(403).json({
        success: false,
        message: isPremium
          ? "Penjadwalan maksimal 30 hari ke depan!"
          : "🔒 Free Plan hanya dapat membuat penjadwalan maksimal 7 hari ke depan. Upgrade ke Premium untuk penjadwalan hingga 30 hari!"
      });
    }

    if (req.file && !isPremium) {
      return res.status(403).json({
        success: false,
        message: "🔒 Fitur lampiran media hanya tersedia untuk pengguna Premium!"
      });
    }

    if (isViewOnce === "true" && !isPremium) {
      return res.status(403).json({
        success: false,
        message: "🔒 Fitur Pesan Sekali Lihat (View Once) hanya tersedia untuk pengguna Premium!"
      });
    }

    targetJid = normalizeJid(targetJid);

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
      scheduledTime: schedDate,
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

app.post("/api/schedule/delete-batch", verifyToken, async (req, res) => {
  try {
    const { ids, deleteAll } = req.body;

    if (deleteAll) {
      const result = await Schedule.deleteMany({ userId: req.user.userId });
      return res.json({ success: true, message: `Semua antrian jadwal (${result.deletedCount} item) berhasil dihapus!` });
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "Pilih minimal satu antrian untuk dihapus." });
    }

    const result = await Schedule.deleteMany({ _id: { $in: ids }, userId: req.user.userId });
    res.json({ success: true, message: `${result.deletedCount} antrian jadwal berhasil dihapus!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

setInterval(async () => {
  try {
    const now = new Date();
    const pendingSchedules = await Schedule.find({
      status: "pending",
      scheduledTime: { $lte: now }
    }).limit(10);

    for (const item of pendingSchedules) {
      const strUserId = String(item.userId);
      const sock = activeSessions.get(strUserId);

      if (!sock) continue;

      try {
        let targetJid = normalizeJid(item.targetJid);
        const isLid = targetJid.endsWith("@lid");
        const sendOptions = isLid ? { additionalAttributes: { addressing_mode: "lid" } } : {};
        const fullMediaPath = item.mediaUrl ? path.join(__dirname, item.mediaUrl) : null;

        console.log(`🚀 [SCHEDULE SENDING] Mengirim ke ${item.targetName} (${targetJid})...`);

        await sock.sendPresenceUpdate("composing", targetJid).catch(() => {});
        await sleep(1500);
        await sock.sendPresenceUpdate("paused", targetJid).catch(() => {});

        if (item.mediaType === "image" && fullMediaPath && fs.existsSync(fullMediaPath)) {
          await sock.sendMessage(targetJid, {
            image: { url: fullMediaPath },
            caption: item.message,
            viewOnce: item.isViewOnce
          }, sendOptions);
        } else if (item.mediaType === "video" && fullMediaPath && fs.existsSync(fullMediaPath)) {
          await sock.sendMessage(targetJid, {
            video: { url: fullMediaPath },
            caption: item.message,
            viewOnce: item.isViewOnce
          }, sendOptions);
        } else if (item.mediaType === "document" && fullMediaPath && fs.existsSync(fullMediaPath)) {
          await sock.sendMessage(targetJid, {
            document: { url: fullMediaPath },
            fileName: path.basename(fullMediaPath),
            caption: item.message
          }, sendOptions);
        } else {
          await sock.sendMessage(targetJid, { text: item.message }, sendOptions);
        }

        item.status = "sent";
        await item.save();

        io.to(strUserId).emit("chat-log", {
          time: new Date().toLocaleTimeString(),
          sender: "SCHEDULED BOT",
          text: `[Terkirim ke ${item.targetName}] ${item.message}`,
          type: "out"
        });

        console.log(`✅ [SCHEDULE SUCCESS] Terkirim ke ${item.targetName} (${targetJid})`);
      } catch (sendErr) {
        console.error(`❌ [SCHEDULE ERR]:`, sendErr.message);
        item.status = "failed";
        item.errorMessage = sendErr.message;
        await item.save();
      }

      await sleep(2500);
    }
  } catch (cronErr) {
    console.error("Scheduler Worker Error:", cronErr.message);
  }
}, 5000);

async function sendHumanizedReply(sock, rawMsg, replyText) {
  try {
    const primaryJid = rawMsg?.key?.remoteJid;
    if (!primaryJid) {
      console.error("❌ [DELIVERY FAILED] JID asal tidak valid!");
      return false;
    }

    const randomJitter = Math.floor(Math.random() * 1200) + 1000;
    await sleep(randomJitter);

    await sock.sendPresenceUpdate("composing", primaryJid).catch(() => {});

    const typingDuration = Math.min(Math.max(replyText.length * 35, 1200), 3500);
    await sleep(typingDuration);

    await sock.sendPresenceUpdate("paused", primaryJid).catch(() => {});

    console.log(`📤 [SENDING TO WHATSAPP] Target JID: ${primaryJid}`);

    const isLid = primaryJid.endsWith("@lid");
    const options = isLid ? { additionalAttributes: { addressing_mode: "lid" } } : {};

    try {
      const result = await sock.sendMessage(primaryJid, { text: replyText }, options);
      if (result?.key?.id) {
        console.log(`✅ [WA DELIVERED] Berhasil dikirim ke: ${primaryJid} | ID: ${result.key.id}`);
        return true;
      }
    } catch (primaryErr) {
      console.warn(`⚠️ [PRIMARY DELIVERY FAIL] JID ${primaryJid} gagal: ${primaryErr.message}. Mencoba fallback JID...`);
    }

    const altJids = resolveTargetJids(rawMsg).filter(j => j !== primaryJid);
    for (const altJid of altJids) {
      try {
        const isAltLid = altJid.endsWith("@lid");
        const altOpts = isAltLid ? { additionalAttributes: { addressing_mode: "lid" } } : {};

        const altResult = await sock.sendMessage(altJid, { text: replyText }, altOpts);
        if (altResult?.key?.id) {
          console.log(`✅ [WA DELIVERED VIA ALT] Berhasil dikirim ke: ${altJid}`);
          return true;
        }
      } catch (altErr) {
        console.warn(`⚠️ [ALT DELIVERY FAIL] JID ${altJid}: ${altErr.message}`);
      }
    }

    return false;

  } catch (err) {
    console.error("❌ Send Reply Error:", err.message);
    return false;
  }
}

async function handleAIBotReply(strUserId, senderNumber, combinedText, sock, rawMsg) {
  try {
    const user = await User.findById(strUserId);
    if (!user) return;

    if (user.isBotActive === false || user.isBotActive === "false") {
      console.log(`⏸️ [BOT NONAKTIF] User ${strUserId} mematikan respon otomatis.`);
      return;
    }

    if (isSenderRateLimited(senderNumber)) {
      console.warn(`⚠️ [RATE LIMIT TRIGGERED] Pengirim ${senderNumber} terlalu sering mengirim pesan. Diabaikan demi keamanan akun WA.`);
      return;
    }

    if (rawMsg?.key?.id) {
      setTimeout(() => {
        sock.readMessages([{
          remoteJid: rawMsg.key.remoteJid,
          id: rawMsg.key.id,
          participant: rawMsg.key.participant
        }]).catch(() => {});
      }, 800);
    }

    let conv = await Conversation.findOne({ botUserId: strUserId, senderNumber });
    if (!conv) {
      conv = await Conversation.create({ botUserId: strUserId, senderNumber, messages: [] });
    }

    conv.messages.push({ role: "user", content: combinedText });

    const products = await Product.find({ userId: strUserId });
    let productPromptContext = "";

    if (products.length > 0) {
      productPromptContext = "\n\nKATALOG PRODUK TOKO TERSEDIA:\n" + products.map((p, i) => 
        `${i + 1}. Nama: ${p.name} | Harga: Rp ${Number(p.price).toLocaleString('id-ID')} | Deskripsi: ${p.description || '-'}`
      ).join("\n");
    }

    const historyForAI = conv.messages.slice(-10).map(m => ({
      role: m.role,
      content: m.content
    }));

    const basePrompt = user.systemPrompt || "Kamu adalah asisten AI yang ramah.";
    const fullSystemPrompt = `${basePrompt}${productPromptContext}`;

    const messagesPayload = [
      { role: "system", content: fullSystemPrompt },
      ...historyForAI
    ];

    const userPlan = user.plan || "free";
    console.log(`📡 [AI GENERATION] Memproses respon AI (${userPlan.toUpperCase()}) untuk ${senderNumber}...`);
    
    const reply = await fetchAIResponse(messagesPayload, userPlan);

    conv.messages.push({ role: "assistant", content: reply });
    await conv.save();

    console.log(`📤 [SENDING REPLY] Mengirim balasan humanized ke WhatsApp ${senderNumber}...`);
    
    const isDelivered = await sendHumanizedReply(sock, rawMsg, reply);

    if (isDelivered) {
      await User.findByIdAndUpdate(strUserId, { $inc: { dailyUsageCount: 1 } });

      const primaryJid = rawMsg?.key?.remoteJid;
      if (primaryJid) {
        for (const prod of products) {
          if (prod.imageUrl && (combinedText.toLowerCase().includes(prod.name.toLowerCase()) || reply.toLowerCase().includes(prod.name.toLowerCase()))) {
            const fullImgPath = path.join(__dirname, prod.imageUrl);
            if (fs.existsSync(fullImgPath)) {
              await sleep(1500);
              await sock.sendMessage(primaryJid, {
                image: { url: fullImgPath },
                caption: `📸 Gambar Produk: *${prod.name}*`
              }).catch(() => {});
              break;
            }
          }
        }
      }

      io.to(strUserId).emit("chat-log", {
        time: new Date().toLocaleTimeString(),
        sender: "BOT AI",
        text: reply,
        type: "out"
      });

      if (user.googleRefreshToken && user.googleSpreadsheetId) {
        appendChatToSheet(user.googleRefreshToken, user.googleSpreadsheetId, {
          timestamp: new Date().toLocaleString("id-ID"),
          sender: senderNumber,
          message: combinedText,
          reply: reply
        }).catch(err => console.error("❌ [SHEET APPEND ERR]:", err.message));
      }

      console.log(`✅ [SUCCESS] Pesan balasan sukses terkirim ke WhatsApp ${senderNumber}`);
    } else {
      io.to(strUserId).emit("error-log", {
        time: new Date().toLocaleTimeString(),
        from: senderNumber,
        message: "Gagal mengirim balasan ke WhatsApp. Cek koneksi nomor WhatsApp."
      });

      console.error(`❌ [DELIVERY FAILED] Pesan balasan gagal terkirim ke WhatsApp ${senderNumber}`);
    }

  } catch (err) {
    console.error("❌ Reply Processing Error:", err.message);
  }
}

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
    for (const s of sessions) {
      if (!activeSessions.has(String(s.userId)) && !isStartingSession.has(String(s.userId))) {
        startUserBot(String(s.userId));
      }
    }
  } catch (e) {}
}

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
      markOnlineOnConnect: true,
      syncFullHistory: false,
      browser: ["Ubuntu", "Chrome", "122.0.6261.111"],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000
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
        console.log(`✅ WA Connected: ${strUserId}`);
        
        sock.sendPresenceUpdate("available").catch(() => {});
        io.to(strUserId).emit("status", "Connected");
      }

      if (connection === "close") {
        isStartingSession.delete(strUserId);
        activeSessions.delete(strUserId);

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

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
            !msg ||
            !msg.message || 
            msg.key.fromMe || 
            msg.key.remoteJid?.endsWith("@g.us") ||
            msg.key.remoteJid === "status@broadcast" ||
            msg.key.remoteJid?.endsWith("@newsletter")
          ) continue;

          const text = extractMessageText(msg);
          if (!text || text.trim() === "") continue;

          if (processedMsgIds.has(msg.key.id)) continue;
          processedMsgIds.add(msg.key.id);
          if (processedMsgIds.size > 2000) processedMsgIds.clear();

          const senderNumber = extractPhoneNumber(msg.key.remoteJidAlt || msg.key.remoteJid);

          console.log(`📩 [INCOMING CHAT] User: ${strUserId} | Sender: ${senderNumber} | Raw JID: ${msg.key.remoteJid} | Text: ${text}`);

          io.to(strUserId).emit("chat-log", {
            time: new Date().toLocaleTimeString(),
            sender: senderNumber,
            text: text,
            type: "in"
          });

          const bufferKey = `${strUserId}_${msg.key.remoteJid}`;
          if (!messageBuffers.has(bufferKey)) {
            messageBuffers.set(bufferKey, { 
              messages: [], 
              timer: null, 
              rawMsg: msg 
            });
          }

          const buf = messageBuffers.get(bufferKey);
          buf.messages.push(text);
          buf.rawMsg = msg;

          if (buf.timer) clearTimeout(buf.timer);

          buf.timer = setTimeout(async () => {
            const aggregatedTexts = [...buf.messages];
            const finalRawMsg = buf.rawMsg;
            messageBuffers.delete(bufferKey);

            const combinedText = aggregatedTexts.join("\n");
            await handleAIBotReply(strUserId, senderNumber, combinedText, sock, finalRawMsg);
          }, 1500);
        }
      } catch (err) {
        console.error("Upsert Error:", err.message);
      }
    });

  } catch (error) {
    isStartingSession.delete(strUserId);
  }
}

io.on("connection", (socket) => {
  socket.on("start-bot", (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const strUserId = String(decoded.userId);
      socket.join(strUserId);
      console.log(`🔌 [SOCKET JOIN] User ${strUserId} terhubung ke realtime room.`);
      startUserBot(strUserId);
    } catch {
      socket.emit("status", "Unauthorized");
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server ready di port ${PORT}`));

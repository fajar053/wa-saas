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

const userStores = new Map();

// --- CONFIG UPLOAD MEDIA PENJADWALAN ---
if (!fs.existsSync(path.join(__dirname, "uploads"))) {
  fs.mkdirSync(path.join(__dirname, "uploads"));
}

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

// --- HELPER NORMALISASI JID ---
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

// --- KONFIGURASI OPENROUTER AI ENGINE ---
const OPENROUTER_CONFIG = {
  name: "OpenRouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseUrl: process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1/chat/completions",
  models: [
    "google/gemini-2.5-flash",
    "meta-llama/llama-3.3-70b-instruct",
    "deepseek/deepseek-chat"
  ]
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchAIResponse(messages, strUserId = "", timeoutMs = 15000) {
  if (!OPENROUTER_CONFIG.apiKey) {
    console.error("❌ [OPENROUTER] API Key tidak ditemukan!");
    return "Maaf, konfigurasi API Key server belum diatur dengan benar 🙏";
  }

  for (const model of OPENROUTER_CONFIG.models) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      console.log(`📡 [AI REQUEST] Memanggil model: ${model}`);
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
        await sleep(300);
        continue;
      }

      const data = await response.json().catch(() => null);
      const content = data?.choices?.[0]?.message?.content;

      if (content && content.trim()) {
        console.log(`✅ [AI SUCCESS] Respon dari model: ${model}`);
        return content.trim();
      }

    } catch (err) {
      clearTimeout(timeoutId);
      await sleep(300);
    }
  }

  return "Halo! Terima kasih telah menghubungi kami. Mohon ulangi pesan Anda beberapa saat lagi 🙏";
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

// --- MIDDLEWARE & AUTH ROUTES ---
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

    const loginToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET);
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

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET);
    res.json({ success: true, token, user });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/api/config", verifyToken, async (req, res) => {
  const user = await User.findById(req.user.userId);
  if (!user) return res.status(404).json({ message: "User not found" });

  res.json({
    email: user.email,
    nickname: user.nickname,
    username: user.username,
    role: user.role || "user",
    profilePicture: user.profilePicture || `https://api.dicebear.com/7.x/bottts/svg?seed=${user.username}`,
    systemPrompt: user.systemPrompt,
    isBotActive: user.isBotActive !== false,
    plan: user.plan || "free",
    dailyUsage: user.dailyUsageCount || 0,
    dailyLimit: user.plan === "premium" ? "Unlimited" : 200
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

// --- API WA SCHEDULE ---
app.get("/api/schedule/targets", verifyToken, async (req, res) => {
  try {
    const strUserId = String(req.user.userId);
    const sock = activeSessions.get(strUserId);

    if (!sock) {
      return res.status(400).json({ success: false, message: "WhatsApp belum terhubung!" });
    }

    const targetsMap = new Map();

    // 1. Ambil kontak dari Riwayat Percakapan AI
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

    // 2. Ambil kontak dari Memori Store Baileys
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

    // 3. Ambil daftar Grup tempat Bot bergabung secara aman
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
    let { targetJid, targetName, targetType, message, scheduledTime, isViewOnce } = req.body;

    if (!targetJid || !scheduledTime) {
      return res.status(400).json({ success: false, message: "Target dan waktu kirim wajib diisi!" });
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

// --- WORKER PENJADWAL OTOMATIS (SCHEDULE ENGINE INDEPENDEN) ---
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

      await sleep(1000);
    }
  } catch (cronErr) {
    console.error("Scheduler Worker Error:", cronErr.message);
  }
}, 4000);

// --- HELPER BALASAN CHAT AI ---
async function sendHumanizedReply(sock, rawMsg, replyText) {
  try {
    sock.sendPresenceUpdate("available").catch(() => {});

    const targetJids = resolveTargetJids(rawMsg);
    console.log(`📤 [TARGET JIDS DELIVERY]:`, targetJids);

    let sentSuccess = false;

    for (const jid of targetJids) {
      try {
        const isLid = jid.endsWith("@lid");
        const options = isLid ? { additionalAttributes: { addressing_mode: "lid" } } : {};

        const result = await sock.sendMessage(jid, { text: replyText }, options);
        if (result?.key?.id) {
          console.log(`✅ [MESSAGE DELIVERED] JID: ${jid} | ID: ${result.key.id}`);
          sentSuccess = true;
        }
      } catch (err) {
        console.warn(`⚠️ [DELIVERY FAILED] JID: ${jid} - Error: ${err.message}`);
      }
    }

    if (!sentSuccess && rawMsg?.key?.remoteJid) {
      const fallbackJid = rawMsg.key.remoteJid;
      console.log(`🔄 [FALLBACK DELIVERY] Kirim ke raw remoteJid: ${fallbackJid}`);
      await sock.sendMessage(fallbackJid, { text: replyText });
    }
  } catch (err) {
    console.error("❌ Send Reply Error:", err.message);
  }
}

// --- PEMROSESAN BALASAN AI AUTOMATIS ---
async function handleAIBotReply(strUserId, senderNumber, combinedText, sock, rawMsg) {
  try {
    const user = await User.findById(strUserId);
    if (!user) return;

    if (user.isBotActive === false || user.isBotActive === "false") {
      console.log(`⏸️ [BOT NONAKTIF] User ${strUserId} mematikan respon otomatis.`);
      return;
    }

    if (rawMsg?.key?.id) {
      sock.readMessages([{
        remoteJid: rawMsg.key.remoteJid,
        id: rawMsg.key.id,
        participant: rawMsg.key.participant
      }]).catch(() => {});
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

    console.log(`📡 [AI GENERATION] Memproses respon AI untuk ${senderNumber}...`);
    const reply = await fetchAIResponse(messagesPayload, strUserId);

    conv.messages.push({ role: "assistant", content: reply });
    await conv.save();

    console.log(`📤 [SENDING REPLY] Mengirim balasan ke ${senderNumber}...`);
    await sendHumanizedReply(sock, rawMsg, reply);

    await User.findByIdAndUpdate(strUserId, { $inc: { dailyUsageCount: 1 } });

    io.to(strUserId).emit("chat-log", {
      time: new Date().toLocaleTimeString(),
      sender: "BOT AI",
      text: reply,
      type: "out"
    });

    console.log(`✅ [AI SUCCESS] Pesan terkirim ke ${senderNumber}: "${reply.slice(0, 30)}..."`);

  } catch (err) {
    console.error("❌ Reply Error:", err.message);
  }
}

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
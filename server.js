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
import nodemailer from "nodemailer";
import multer from "multer";
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
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Pastikan folder uploads ada
if (!fs.existsSync(path.join(__dirname, "uploads"))) {
  fs.mkdirSync(path.join(__dirname, "uploads"));
}

// Konfigurasi Multer untuk Upload Foto
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `avatar_${req.user.userId}_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

// Konfigurasi Transporter Nodemailer
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT) || 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
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
const connectedFlags = new Set();
const userSockets = new Map();

// --- AUTHENTICATION & ACCOUNT API ---

// 1. REGISTER
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
      verificationToken
    });

    const verifyLink = `${process.env.APP_URL || 'http://localhost:3000'}/api/verify-email?token=${verificationToken}`;
    
    await transporter.sendMail({
      from: `"WA AutoBot AI" <${process.env.SMTP_USER}>`,
      to: email,
      subject: "Aktivasi Akun WA AutoBot AI",
      html: `
        <h3>Halo ${nickname},</h3>
        <p>Terima kasih telah mendaftar di WA AutoBot AI. Klik tombol di bawah ini untuk memverifikasi email kamu:</p>
        <a href="${verifyLink}" style="background:#4F46E5;color:white;padding:10px 20px;text-decoration:none;border-radius:8px;display:inline-block;">Aktivasi Akun Saya</a>
        <p>Atau buka link berikut: <a href="${verifyLink}">${verifyLink}</a></p>
      `
    });

    res.json({ success: true, message: "Pendaftaran berhasil! Silakan cek email kamu untuk verifikasi akun." });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 2. VERIFIKASI EMAIL
app.get("/api/verify-email", async (req, res) => {
  try {
    const { token } = req.query;
    const user = await User.findOne({ verificationToken: token });

    if (!user) {
      return res.send(`<h2>Token verifikasi tidak valid atau sudah kadaluwarsa.</h2><a href="/login.html">Ke Halaman Login</a>`);
    }

    user.isVerified = true;
    user.verificationToken = null;
    await user.save();

    res.send(`<h2>Email berhasil diverifikasi!</h2><p>Sekarang kamu bisa login.</p><a href="/">Login Sekarang</a>`);
  } catch (e) {
    res.status(500).send("Terjadi kesalahan pada server.");
  }
});

// 3. LOGIN
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ success: false, message: "Email atau Password salah!" });
    }

    if (!user.isVerified) {
      return res.status(400).json({ success: false, message: "Akun belum diverifikasi! Silakan cek email kamu." });
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET);
    res.json({ success: true, token, user });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 4. LUPA PASSWORD (KIRIM LINK RESET)
app.post("/api/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ success: false, message: "Email tidak ditemukan!" });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 jam
    await user.save();

    const resetLink = `${process.env.APP_URL || 'http://localhost:3000'}/reset-password.html?token=${resetToken}`;

    await transporter.sendMail({
      from: `"WA AutoBot AI" <${process.env.SMTP_USER}>`,
      to: email,
      subject: "Reset Password Akun WA AutoBot AI",
      html: `
        <h3>Halo ${user.nickname},</h3>
        <p>Kamu menerima email ini karena ada permintaan reset password. Klik tombol di bawah ini untuk mengubah password kamu:</p>
        <a href="${resetLink}" style="background:#EF4444;color:white;padding:10px 20px;text-decoration:none;border-radius:8px;display:inline-block;">Reset Password</a>
        <p>Link ini berlaku selama 1 jam.</p>
      `
    });

    res.json({ success: true, message: "Link reset password telah dikirim ke email kamu!" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 5. RESET PASSWORD BARU
app.post("/api/reset-password", async (req, res) => {
  try {
    const { token, newPassword, confirmPassword } = req.body;

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: "Konfirmasi password tidak cocok!" });
    }

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({ success: false, message: "Token reset password tidak valid atau sudah expired!" });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();

    res.json({ success: true, message: "Password berhasil diperbarui! Silakan login kembali." });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// MIDDLEWARE AUTHENTICATION
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

// 6. GET USER PROFILE & CONFIG
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
    profilePicture: user.profilePicture,
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

// 7. UPDATE PROFILE & PASSWORD
app.post("/api/profile/update", verifyToken, upload.single("avatar"), async (req, res) => {
  try {
    const { nickname, oldPassword, newPassword } = req.body;
    const user = await User.findById(req.user.userId);

    if (nickname) user.nickname = nickname;

    if (req.file) {
      user.profilePicture = `/uploads/${req.file.filename}`;
    }

    if (newPassword) {
      if (!oldPassword || !(await bcrypt.compare(oldPassword, user.password))) {
        return res.status(400).json({ success: false, message: "Password lama salah!" });
      }
      user.password = await bcrypt.hash(newPassword, 10);
    }

    await user.save();
    res.json({ success: true, message: "Profil berhasil diperbarui!", profilePicture: user.profilePicture });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- MONGODB AUTH STATE BAILEYS ---
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

async function autoStartAllSessions() {
  try {
    const sessions = await Session.find({});
    for (const session of sessions) {
      if (!activeSessions.has(String(session.userId)) && !isStartingSession.has(String(session.userId))) {
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
  const strUserId = String(userId);
  if (socket) userSockets.set(strUserId, socket);

  if (activeSessions.has(strUserId) && activeSessions.get(strUserId)?.ws?.isOpen) {
    const currentSocket = userSockets.get(strUserId);
    currentSocket?.emit("status", "Connected");
    currentSocket?.emit("ready");
    return;
  }

  if (isStartingSession.has(strUserId)) return;
  isStartingSession.add(strUserId);

  try {
    const { state, saveCreds } = await useMongoDBAuthState(strUserId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      auth: state,
      printQRInTerminal: false
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
        if (!connectedFlags.has(strUserId)) {
          console.log(`✅ WA Connected for User: ${strUserId}`);
          connectedFlags.add(strUserId);
        }
        currentSocket?.emit("status", "Connected");
        currentSocket?.emit("ready");
      }

      if (connection === "close") {
        isStartingSession.delete(strUserId);
        connectedFlags.delete(strUserId);
        activeSessions.delete(strUserId);

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLogout = statusCode === DisconnectReason.loggedOut;

        if (isLogout) {
          await Session.deleteOne({ userId: strUserId });
          currentSocket?.emit("status", "Disconnected");
        } else {
          setTimeout(() => {
            startUserBot(strUserId, currentSocket);
          }, 3000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid.endsWith("@g.us")) continue;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) continue;

        try {
          await sock.readMessages([msg.key]);
        } catch (e) {}

        const senderNumber = msg.key.remoteJid.split("@")[0].split(":")[0];
        const targetSocket = userSockets.get(strUserId);

        targetSocket?.emit("chat-log", {
          time: new Date().toLocaleTimeString(),
          sender: senderNumber,
          text: text,
          type: "in"
        });

        const user = await User.findById(strUserId);
        if (!user || !user.isBotActive) continue;

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

          await User.findByIdAndUpdate(strUserId, { $inc: { dailyUsageCount: 1 } });

          targetSocket?.emit("chat-log", {
            time: new Date().toLocaleTimeString(),
            sender: senderNumber,
            text: reply,
            type: "out"
          });

        } catch (err) {
          console.error("AI Error:", err.message);
          targetSocket?.emit("error-log", { time: new Date().toLocaleTimeString(), message: err.message, from: senderNumber });
        }
      }
    });

  } catch (error) {
    console.error("Error starting bot:", error.message);
    isStartingSession.delete(strUserId);
  }
}

// SOCKET.IO REALTIME
io.on("connection", (socket) => {
  socket.on("start-bot", (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const strUserId = String(decoded.userId);
      userSockets.set(strUserId, socket);
      startUserBot(strUserId, socket);
    } catch (e) {
      socket.emit("status", "Unauthorized");
    }
  });

  socket.on("disconnect", () => {
    for (const [userId, sock] of userSockets.entries()) {
      if (sock.id === socket.id) {
        userSockets.delete(userId);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server ready di port ${PORT}`));
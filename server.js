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

// Direct Landing Page ke index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Pastikan folder uploads ada
if (!fs.existsSync(path.join(__dirname, "uploads"))) {
  fs.mkdirSync(path.join(__dirname, "uploads"));
}

// Konfigurasi Multer untuk Upload Foto Profil
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `avatar_${req.user.userId}_${Date.now()}${ext}`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 1 * 1024 * 1024 }, // Maksimal 1 MB
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

// --- HELPER MULTI-PROVIDER AI (OPENROUTER & ORCAROUTER) ---
async function fetchAIResponse(provider, apiKey, messages, modelCandidate = "", targetSocket = null, senderNumber = "") {
  let apiBaseUrl = "https://openrouter.ai/api/v1/chat/completions";
  let defaultModels = [
    modelCandidate,
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "poolside/laguna-s-2.1:free",
    "minimax/minimax-m3:free"
  ];
  let siteTitle = "WA AutoBot AI";

  if (provider === "orcarouter") {
    apiBaseUrl = "https://api.orcarouter.ai/v1/chat/completions";
    defaultModels = [
      modelCandidate,
      "deepseek/deepseek-v4-flash-free",
      "orcarouter/free",
      "qwen/qwen3.8-27b-free"
    ];
    siteTitle = "OrcaRouter Gateway";
  }

  const uniqueModels = [...new Set(defaultModels)].filter(Boolean);

  for (const model of uniqueModels) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    try {
      const response = await fetch(apiBaseUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
          "X-Title": siteTitle
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
        console.warn(`⚠️ [${provider.toUpperCase()}] Model ${model} Failed (${response.status}): ${errText}`);
        
        if (model === modelCandidate && targetSocket) {
          targetSocket.emit("error-log", {
            time: new Date().toLocaleTimeString(),
            message: `[${provider.toUpperCase()}] Model "${modelCandidate}" error (${response.status}). Berpindah ke model cadangan.`,
            from: senderNumber || "Sistem"
          });
        }
        continue;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        console.log(`✅ AI Response Generated via [${provider.toUpperCase()}]: ${model}`);
        return content;
      }

    } catch (err) {
      console.warn(`⚠️ [${provider.toUpperCase()}] Model ${model} Connection Error: ${err.message}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error(`Semua server AI pada provider ${provider.toUpperCase()} sedang sibuk.`);
}

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

    const defaultAvatar = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}`;

    await User.create({
      nickname,
      username,
      email,
      password: hashedPassword,
      verificationToken,
      profilePicture: defaultAvatar
    });

    const verifyLink = `${process.env.APP_URL || 'http://localhost:3000'}/api/verify-email?token=${verificationToken}`;
    
    try {
      const emailResponse = await resend.emails.send({
        from: "WA AutoBot AI <noreply@wasaas.my.id>",
        to: [email],
        subject: "Aktivasi Akun WA AutoBot AI",
        html: `
          <h3>Halo ${nickname},</h3>
          <p>Terima kasih telah mendaftar di WA AutoBot AI. Klik tombol di bawah ini untuk memverifikasi email kamu:</p>
          <a href="${verifyLink}" style="background:#4F46E5;color:white;padding:10px 20px;text-decoration:none;border-radius:8px;display:inline-block;">Aktivasi Akun Saya</a>
          <p>Atau buka link berikut: <a href="${verifyLink}">${verifyLink}</a></p>
        `
      });

      if (emailResponse.error) {
        console.error("⚠️ Resend API Error:", emailResponse.error.message);
        return res.json({ 
          success: true, 
          message: `Pendaftaran berhasil! Jika email belum diterima, gunakan link aktivasi ini: ${verifyLink}` 
        });
      }

      console.log("✅ Email Verifikasi Terkirim ID:", emailResponse.data.id);
      res.json({ success: true, message: "Pendaftaran berhasil! Silakan cek inbox/spam email kamu untuk verifikasi akun." });

    } catch (mailErr) {
      console.error("❌ Exception Kirim Email:", mailErr.message);
      res.json({ 
        success: true, 
        message: `Pendaftaran berhasil! Klik link verifikasi ini untuk mengaktifkan akun: ${verifyLink}` 
      });
    }

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
      return res.send(`
        <!DOCTYPE html>
        <html lang="id">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Verifikasi Gagal - WA AutoBot AI</title>
          <script src="https://cdn.tailwindcss.com"></script>
          <script src="https://unpkg.com/lucide@latest"></script>
        </head>
        <body class="bg-slate-900 text-slate-100 flex items-center justify-center min-h-screen p-4">
          <div class="bg-slate-800 border border-slate-700/60 rounded-2xl p-8 max-w-md w-full text-center shadow-2xl space-y-4">
            <div class="w-16 h-16 bg-rose-500/10 text-rose-400 rounded-full flex items-center justify-center mx-auto border border-rose-500/20">
              <i data-lucide="alert-triangle" class="w-8 h-8"></i>
            </div>
            <h2 class="text-xl font-bold text-slate-100">Token Tidak Valid / Expired</h2>
            <p class="text-xs text-slate-400 leading-relaxed">
              Token verifikasi email kamu tidak ditemukan atau sudah kadaluwarsa. Silakan minta email verifikasi baru melalui halaman login.
            </p>
            <a href="/login.html" class="inline-block w-full bg-slate-700 hover:bg-slate-600 font-bold py-3 rounded-xl transition text-xs">
              Ke Halaman Login
            </a>
          </div>
          <script>lucide.createIcons();</script>
        </body>
        </html>
      `);
    }

    user.isVerified = true;
    user.verificationToken = null;
    await user.save();

    const loginToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET);

    res.send(`
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Email Terverifikasi - WA AutoBot AI</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://unpkg.com/lucide@latest"></script>
      </head>
      <body class="bg-slate-900 text-slate-100 flex items-center justify-center min-h-screen p-4">
        <div class="bg-slate-800 border border-slate-700/60 rounded-2xl p-8 max-w-md w-full text-center shadow-2xl space-y-6">
          <div class="w-20 h-20 bg-emerald-500/10 text-emerald-400 rounded-full flex items-center justify-center mx-auto border border-emerald-500/20 shadow-lg shadow-emerald-500/10">
            <i data-lucide="check-circle-2" class="w-10 h-10"></i>
          </div>

          <div class="space-y-2">
            <h2 class="text-2xl font-bold text-slate-100">Verifikasi Berhasil!</h2>
            <p class="text-xs text-slate-300 leading-relaxed">
              Selamat, email kamu <span class="text-indigo-400 font-semibold">${user.email}</span> telah aktif.
            </p>
          </div>

          <div class="bg-slate-900 border border-slate-700/50 rounded-xl p-4 flex items-center justify-center gap-3">
            <div class="w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin"></div>
            <p class="text-xs text-slate-400">Mengalihkan kamu ke Dashboard dalam <span id="countdown" class="font-bold text-indigo-400">3</span> detik...</p>
          </div>

          <a href="/dashboard.html" class="inline-block w-full bg-indigo-600 hover:bg-indigo-500 font-bold py-3 rounded-xl transition text-xs shadow-lg shadow-indigo-600/20">
            Masuk ke Dashboard Sekarang
          </a>
        </div>

        <script>
          lucide.createIcons();
          localStorage.setItem('token', '${loginToken}');

          let timeLeft = 3;
          const countdownEl = document.getElementById('countdown');
          const timer = setInterval(() => {
            timeLeft--;
            if (countdownEl) countdownEl.innerText = timeLeft;
            if (timeLeft <= 0) {
              clearInterval(timer);
              window.location.href = '/dashboard.html';
            }
          }, 1000);
        </script>
      </body>
      </html>
    `);
  } catch (e) {
    res.status(500).send("Terjadi kesalahan pada server.");
  }
});

// 3. KIRIM ULANG EMAIL VERIFIKASI
app.post("/api/resend-verification", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email wajib diisi!" });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ success: false, message: "Email tidak ditemukan!" });
    }

    if (user.isVerified) {
      return res.status(400).json({ success: false, message: "Akun dengan email ini sudah terverifikasi. Silakan langsung login." });
    }

    if (!user.verificationToken) {
      user.verificationToken = crypto.randomBytes(32).toString("hex");
      await user.save();
    }

    const verifyLink = `${process.env.APP_URL || 'http://localhost:3000'}/api/verify-email?token=${user.verificationToken}`;

    try {
      await resend.emails.send({
        from: "WA AutoBot AI <noreply@wasaas.my.id>",
        to: [email],
        subject: "Kirim Ulang: Aktivasi Akun WA AutoBot AI",
        html: `
          <h3>Halo ${user.nickname},</h3>
          <p>Kamu meminta pengiriman ulang link verifikasi akun. Klik tombol di bawah ini untuk mengaktifkan akun kamu:</p>
          <a href="${verifyLink}" style="background:#4F46E5;color:white;padding:10px 20px;text-decoration:none;border-radius:8px;display:inline-block;">Aktivasi Akun Saya</a>
          <p>Atau buka link berikut: <a href="${verifyLink}">${verifyLink}</a></p>
        `
      });

      res.json({ success: true, message: "Email verifikasi baru berhasil dikirim! Silakan cek inbox/spam kamu." });
    } catch (mailErr) {
      console.error("❌ Resend Error:", mailErr.message);
      res.json({ 
        success: true, 
        message: `Jika email tidak muncul, kamu dapat langsung mengklik link aktivasi ini: ${verifyLink}` 
      });
    }

  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 4. LOGIN
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

// 5. LUPA PASSWORD
app.post("/api/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ success: false, message: "Email tidak ditemukan!" });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 3600000;
    await user.save();

    const resetLink = `${process.env.APP_URL || 'http://localhost:3000'}/reset-password.html?token=${resetToken}`;

    await resend.emails.send({
      from: "WA AutoBot AI <noreply@wasaas.my.id>",
      to: [email],
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

// 6. RESET PASSWORD
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

// 7. GET USER PROFILE & CONFIG
app.get("/api/config", verifyToken, async (req, res) => {
  const user = await User.findById(req.user.userId);
  const today = new Date().toISOString().split("T")[0];
  
  if (user.dailyUsageDate !== today) {
    user.dailyUsageDate = today;
    user.dailyUsageCount = 0;
    await user.save();
  }

  if (user.plan === "premium" && user.expiredAt && new Date() > new Date(user.expiredAt)) {
    user.plan = "free";
    await user.save();
  }

  res.json({
    email: user.email,
    nickname: user.nickname,
    username: user.username,
    profilePicture: user.profilePicture || `https://api.dicebear.com/7.x/bottts/svg?seed=${user.username}`,
    openrouterApiKey: user.openrouterApiKey || user.apiKey || "",
    orcarouterApiKey: user.orcarouterApiKey || "",
    aiProvider: user.aiProvider || "openrouter",
    modelName: user.modelName,
    systemPrompt: user.systemPrompt,
    isBotActive: user.isBotActive,
    plan: user.plan || "free",
    expiredAt: user.expiredAt,
    dailyUsage: user.dailyUsageCount || 0,
    dailyLimit: user.plan === "premium" ? "Unlimited" : 50
  });
});

app.post("/api/config", verifyToken, async (req, res) => {
  try {
    const { aiProvider, openrouterApiKey, orcarouterApiKey, modelName, systemPrompt, isBotActive } = req.body;
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ success: false, message: "User tidak ditemukan" });

    user.aiProvider = aiProvider || "openrouter";
    user.modelName = modelName;
    user.systemPrompt = systemPrompt;
    user.isBotActive = isBotActive;

    if (openrouterApiKey !== undefined && openrouterApiKey.trim() !== "") {
      user.openrouterApiKey = openrouterApiKey.trim();
      user.apiKey = openrouterApiKey.trim(); // simpan ke legacy field juga untuk fallback
    }
    if (orcarouterApiKey !== undefined && orcarouterApiKey.trim() !== "") {
      user.orcarouterApiKey = orcarouterApiKey.trim();
    }

    await user.save();
    res.json({ success: true, message: "Pengaturan berhasil disimpan!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 8. AUTO GENERATE SYSTEM PROMPT VIA NATIVE FETCH
app.post("/api/generate-prompt", verifyToken, async (req, res) => {
  try {
    const { promptText, mode } = req.body;
    const user = await User.findById(req.user.userId);

    if (mode === "very_detailed" && user.plan !== "premium") {
      return res.status(403).json({ 
        success: false, 
        message: "Fitur 'Sangat Detail (~700 kata)' khusus untuk pengguna Plan Premium! Silakan tingkatkan langganan Anda." 
      });
    }

    if (!promptText || !promptText.trim()) {
      return res.status(400).json({ success: false, message: "Ketikkan instruksi singkat terlebih dahulu pada kolom System Prompt!" });
    }

    const activeKey = (user.aiProvider === "orcarouter" ? user.orcarouterApiKey : user.openrouterApiKey) || user.apiKey;
    if (!activeKey || !activeKey.trim()) {
      return res.status(400).json({ 
        success: false, 
        message: `API Key untuk provider ${user.aiProvider} belum diisi. Masukkan API Key kamu pada pengaturan di atas terlebih dahulu!` 
      });
    }

    const wordTarget = mode === "very_detailed" ? "700" : "100";
    const modeLabel = mode === "very_detailed" ? "SANGAT DETAIL" : "DETAIL";

    const systemInstruction = `Kamu adalah seorang AI Prompt Engineer ahli. Tugasmu adalah mengembangkan instruksi/informasi singkat menjadi System Prompt / Pelatihan Bot WhatsApp yang sangat komprehensif, profesional, dan siap pakai.

Aturan Pembuatan:
1. Buat hasilnya dalam bentuk instruksi System Prompt (meliputi Peran Bot, Gaya Bahasa, Aturan Komunikasi, Batasan Jawaban, dan Contoh Respon).
2. Hasil prompt HARUS panjang dan mendalam dengan target sekitar ${wordTarget} kata (opsi ${modeLabel}).
3. Gunakan Bahasa Indonesia yang jelas, sopan, dan terstruktur.
4. Jangan tambahkan kalimat sapaan/pembuka/penutup seperti "Tentu, ini prompt kamu:". Langsung keluarkan teks System Prompt-nya saja.`;

    const messages = [
      { role: "system", content: systemInstruction },
      { role: "user", content: `Kembangkan prompt singkat berikut menjadi System Prompt Pelatihan Bot WhatsApp (${wordTarget} kata):\n"${promptText}"` }
    ];

    const generatedPrompt = await fetchAIResponse(user.aiProvider || "openrouter", activeKey, messages, user.modelName);
    res.json({ success: true, generatedPrompt });

  } catch (err) {
    console.error("Generate Prompt Error:", err.message);
    res.status(500).json({ success: false, message: `Gagal generate prompt: ${err.message}` });
  }
});

// 9. PAYMENT & SUBSCRIPTION ENDPOINTS
app.post("/api/subscribe/create", verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    const orderId = `SUBS-${user._id}-${Date.now()}`;
    const amount = 49000;

    res.json({
      success: true,
      orderId,
      amount,
      message: "Silakan selesaikan pembayaran Rp 49.000 untuk berlangganan Premium 30 Hari.",
      paymentUrl: `https://tripay.co.id/checkout/${orderId}`
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/api/payment/webhook", async (req, res) => {
  try {
    const { order_id, status, userId } = req.body;

    if (status === "PAID" || status === "settlement") {
      const expiredDate = new Date();
      expiredDate.setDate(expiredDate.getDate() + 30);

      await User.findByIdAndUpdate(userId, {
        plan: "premium",
        expiredAt: expiredDate
      });

      console.log(`✅ User ${userId} berhasil otomatis di-upgrade ke PREMIUM!`);
      return res.json({ success: true, message: "Webhook processed successfully" });
    }

    res.json({ success: true, message: "Transaction pending/failed" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 10. UPDATE PROFILE & FOTO PROFIL
app.post("/api/profile/update", verifyToken, (req, res) => {
  upload.single("avatar")(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ success: false, message: "Ukuran foto terlalu besar! Maksimal 1 MB." });
      }
      return res.status(400).json({ success: false, message: err.message });
    } else if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

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
});

// 11. RESET SESI WHATSAPP (MENGATASI BAD MAC ERROR)
app.post("/api/whatsapp/reset", verifyToken, async (req, res) => {
  try {
    const strUserId = String(req.user.userId);
    
    if (activeSessions.has(strUserId)) {
      try {
        activeSessions.get(strUserId).end();
      } catch (e) {}
      activeSessions.delete(strUserId);
    }
    
    await Session.deleteOne({ userId: strUserId });
    
    res.json({ success: true, message: "Sesi WhatsApp berhasil direset. Silakan scan QR Code ulang!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- MONGODB AUTH STATE BAILEYS ---
async function useMongoDBAuthState(userId) {
  let session = await Session.findOne({ userId: String(userId) });
  let creds;
  let keys = {};

  if (session && session.data) {
    try {
      const parsed = JSON.parse(session.data, BufferJSON.reviver);
      creds = parsed.creds || initAuthCreds();
      keys = parsed.keys || {};
    } catch (e) {
      creds = initAuthCreds();
      keys = {};
    }
  } else {
    creds = initAuthCreds();
  }

  const saveCreds = async () => {
    try {
      const dataStr = JSON.stringify({ creds, keys }, BufferJSON.replacer);
      await Session.findOneAndUpdate(
        { userId: String(userId) },
        { data: dataStr },
        { upsert: true, new: true }
      );
    } catch (err) {
      console.error(`❌ Error saving auth credentials for ${userId}:`, err.message);
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
    // Bersihkan sesi lama jika ada sebelum membuka socket baru
    if (activeSessions.has(strUserId)) {
      try { activeSessions.get(strUserId)?.end(); } catch (e) {}
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
          }, 5000);
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

          const text = 
            msg.message.conversation || 
            msg.message.extendedTextMessage?.text || 
            msg.message.imageMessage?.caption || 
            "";

          if (!text) continue;

          try {
            await sock.readMessages([{
              remoteJid: msg.key.remoteJid,
              id: msg.key.id,
              participant: msg.key.participant
            }]);
          } catch (readErr) {
            console.error("Auto Read Error:", readErr.message);
          }

          const senderNumber = msg.key.remoteJid.split("@")[0].split(":")[0];
          const targetSocket = userSockets.get(strUserId);

          targetSocket?.emit("chat-log", {
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            sender: senderNumber,
            text: text,
            type: "in"
          });

          // Pengecekan API Key dengan fallback otomatis ke user.apiKey jika field provider belum terisi
          const activeKey = (user.aiProvider === "orcarouter" ? user.orcarouterApiKey : user.openrouterApiKey) || user.apiKey;
          if (!activeKey || !activeKey.trim()) {
            const errorMsg = `API Key untuk provider ${user.aiProvider || 'OpenRouter'} belum diisi.`;
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

          if (user.plan === "free" && user.dailyUsageCount >= 50) {
            const limitMsg = "Batas kuota gratis harian (50 chat) telah tercapai.";
            targetSocket?.emit("error-log", { time: new Date().toLocaleTimeString(), message: limitMsg, from: senderNumber });
            await sock.sendMessage(msg.key.remoteJid, { text: "[Sistem] Maaf, kuota pembalasan harian bot ini telah habis (50/50)." });
            continue;
          }

          let conv = await Conversation.findOne({ botUserId: strUserId, senderNumber });
          if (!conv) {
            conv = await Conversation.create({ botUserId: strUserId, senderNumber, messages: [] });
          }

          const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
          let wasMemoryReset = false;

          if (Date.now() - new Date(conv.lastClearedAt).getTime() > THREE_DAYS_MS) {
            conv.messages = [];
            conv.lastClearedAt = new Date();
            await conv.save();
            wasMemoryReset = true;
          }

          if (!conv.knownName) {
            const nameMatch = text.match(/(?:nama aku|namaku|aku|panggil aku|nama saya)\s+([a-zA-Z]+)/i);
            if (nameMatch && nameMatch[1]) {
              conv.knownName = nameMatch[1];
            }
          }

          conv.messages.push({ role: "user", content: text });

          let dynamicSystemPrompt = user.systemPrompt || "Kamu adalah asisten AI yang ramah.";

          if (conv.knownName) {
            dynamicSystemPrompt += `\n\n[INFO SISTEM]: Nama pengirim percakapan ini adalah "${conv.knownName}". Kamu SUDAH MENGETAHUI namanya. Jangan pernah menanyakan namanya lagi.`;
          }

          if (wasMemoryReset) {
            dynamicSystemPrompt += `\n\n[INFO SISTEM]: Catatan percakapan sebelumnya dengan pengguna ini sudah dibersihkan secara otomatis (setiap 3 hari sekali) agar obrolan tetap lancar.`;
          }

          const historyForAI = conv.messages.slice(-20).map(m => ({
            role: m.role,
            content: m.content
          }));

          const messagesPayload = [
            { role: "system", content: dynamicSystemPrompt },
            ...historyForAI
          ];

          try {
            const selectedModel = user.modelName || "nvidia/nemotron-3-ultra-550b-a55b:free";
            const provider = user.aiProvider || "openrouter";

            const reply = await fetchAIResponse(
              provider,
              activeKey, 
              messagesPayload, 
              selectedModel,
              targetSocket,
              senderNumber
            );

            conv.messages.push({ role: "assistant", content: reply });
            await conv.save();

            await sock.sendMessage(msg.key.remoteJid, { text: reply });
            await User.findByIdAndUpdate(strUserId, { $inc: { dailyUsageCount: 1 } });

            targetSocket?.emit("chat-log", {
              time: new Date().toLocaleTimeString(),
              timestamp: Date.now(),
              sender: senderNumber,
              text: reply,
              type: "out"
            });

          } catch (err) {
            console.error("AI Complete Error:", err.message);
            targetSocket?.emit("error-log", { 
              time: new Date().toLocaleTimeString(), 
              message: `Koneksi AI gagal: ${err.message}`, 
              from: senderNumber 
            });
          }
        }
      } catch (upsertErr) {
        console.error("Upsert Event Error:", upsertErr.message);
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

// Graceful Shutdown Handling untuk mencegah SIGTERM error / crash di Railway
const gracefulShutdown = () => {
  console.log("⚠️ Termination signal received. Closing active WhatsApp sockets & connections...");
  for (const [userId, sock] of activeSessions.entries()) {
    try {
      sock.end();
    } catch (e) {}
  }
  server.close(() => {
    mongoose.connection.close(false, () => {
      process.exit(0);
    });
  });
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server ready di port ${PORT}`));
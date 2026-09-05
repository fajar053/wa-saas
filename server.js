import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import QRCode from "qrcode";
import makeWASocket, { 
  DisconnectReason, 
  fetchLatestBaileysVersion, 
  useMultiFileAuthState 
} from "@whiskeysockets/baileys";
import pino from "pino";

// --- KONFIGURASI SERVER & EXPRESS ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const globalLogger = pino({ level: "fatal" });
const processedMsgIds = new Set();
const messageBuffers = new Map();
const conversationMemory = new Map();

// --- PREVENT PROCESS CRASH ---
process.on("unhandledRejection", (reason) => console.error("⚠️ [UNHANDLED REJECTION]:", reason));
process.on("uncaughtException", (err) => console.error("⚠️ [UNCAUGHT EXCEPTION]:", err));

// --- HELPER NORMALISASI & RESOLUSI JID ---
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
  if (cleanNum.startsWith("0")) cleanNum = "62" + cleanNum.slice(1);
  else if (cleanNum.startsWith("8")) cleanNum = "62" + cleanNum;

  return `${cleanNum}@s.whatsapp.net`;
}

function getBestTargetJid(msg) {
  if (!msg || !msg.key) return "";

  const remoteJid = msg.key.remoteJid || "";
  const remoteJidAlt = msg.key.remoteJidAlt || "";
  const participant = msg.key.participant || msg.participant || "";

  if (remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@g.us")) return normalizeJid(remoteJid);
  if (remoteJidAlt && remoteJidAlt.endsWith("@s.whatsapp.net")) return normalizeJid(remoteJidAlt);
  if (participant && participant.endsWith("@s.whatsapp.net")) return normalizeJid(participant);

  return remoteJid;
}

function extractPhoneNumber(rawJid) {
  if (!rawJid) return "";
  return String(rawJid).split("@")[0].split(":")[0].replace(/[^0-9]/g, "") || rawJid;
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

// --- OPENROUTER AI ENGINE ---
const OPENROUTER_CONFIG = {
  apiKey: process.env.OPENROUTER_API_KEY,
  baseUrl: process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1/chat/completions",
  models: [
    "google/gemini-2.5-flash",
    "meta-llama/llama-3.3-70b-instruct",
    "deepseek/deepseek-chat"
  ]
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchAIResponse(messages) {
  if (!OPENROUTER_CONFIG.apiKey) {
    console.error("❌ [OPENROUTER] API Key tidak ditemukan di .env!");
    return "Maaf, API Key OpenRouter belum dikonfigurasi pada file .env 🙏";
  }

  for (const model of OPENROUTER_CONFIG.models) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      console.log(`📡 [AI REQUEST] Memanggil model: ${model}`);
      const response = await fetch(OPENROUTER_CONFIG.baseUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_CONFIG.apiKey}`,
          "Content-Type": "application/json"
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

  return "Mohon maaf, sistem AI kami sedang sibuk. Silakan coba kirim pesan beberapa saat lagi 🙏";
}

// --- HELPER BALASAN CHAT AUTOMATIS ---
async function sendHumanizedReply(sock, targetJid, replyText, rawMsg) {
  try {
    try { await sock.sendPresenceUpdate("composing", targetJid); } catch (e) {}

    const baseDelay = Math.min(Math.max((replyText || "").length * 15, 800), 2000);
    await sleep(baseDelay);

    const isLid = targetJid.endsWith("@lid");
    let sentMsg;

    if (isLid) {
      try {
        sentMsg = await sock.sendMessage(targetJid, { text: replyText }, {
          additionalAttributes: { addressing_mode: "lid" }
        });
      } catch (e) {}

      const altJid = rawMsg?.key?.remoteJidAlt;
      if (altJid && altJid.endsWith("@s.whatsapp.net") && altJid !== targetJid) {
        try { await sock.sendMessage(normalizeJid(altJid), { text: replyText }); } catch (e) {}
      }
    } else {
      try {
        sentMsg = await sock.sendMessage(targetJid, { text: replyText });
      } catch (e) {
        sentMsg = await sock.sendMessage(targetJid, { text: replyText }, { quoted: rawMsg });
      }
    }

    try { await sock.sendPresenceUpdate("paused", targetJid); } catch (e) {}
    return sentMsg;
  } catch (err) {
    console.error("❌ Send Reply Error:", err.message);
  }
}

async function handleAIBotReply(senderNumber, targetJid, combinedText, sock, rawMsg) {
  try {
    if (rawMsg?.key?.id) {
      try {
        const readJid = rawMsg.key.remoteJid || targetJid;
        await sock.readMessages([{ remoteJid: readJid, id: rawMsg.key.id, participant: rawMsg.key.participant }]);
      } catch (e) {}
    }

    if (!conversationMemory.has(senderNumber)) {
      conversationMemory.set(senderNumber, []);
    }

    const userHistory = conversationMemory.get(senderNumber);
    userHistory.push({ role: "user", content: combinedText });

    if (userHistory.length > 20) userHistory.shift();

    const systemPrompt = process.env.SYSTEM_PROMPT || "Kamu adalah Asisten Bot AI WhatsApp yang ramah, sopan, dan sigap membantu.";
    const messagesPayload = [
      { role: "system", content: systemPrompt },
      ...userHistory.slice(-10)
    ];

    console.log(`📡 [AI GENERATION] Memproses balasan untuk ${senderNumber}...`);
    const reply = await fetchAIResponse(messagesPayload);

    userHistory.push({ role: "assistant", content: reply });

    await sendHumanizedReply(sock, targetJid, reply, rawMsg);

    io.emit("chat-log", {
      time: new Date().toLocaleTimeString(),
      sender: "BOT AI",
      text: reply,
      type: "out"
    });

    console.log(`✅ [AI SUCCESS] Balasan terkirim ke ${senderNumber}: "${reply.slice(0, 30)}..."`);
  } catch (err) {
    console.error("❌ AI Reply Handler Error:", err.message);
  }
}

// --- ENGINE UTAMA BOT WHATSAPP (BAILEYS) ---
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: globalLogger,
    auth: state,
    printQRInTerminal: true,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    browser: ["Ubuntu", "Chrome", "122.0.6261.111"],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrUrl = await QRCode.toDataURL(qr);
      io.emit("qr", qrUrl);
      io.emit("status", "Scan QR Code");
    }

    if (connection === "open") {
      console.log("✅ WA BOT Terhubung & Siap Digunakan!");
      io.emit("status", "Connected");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log("🔄 Koneksi terputus, mencoba menghubungkan kembali...");
        setTimeout(startBot, 5000);
      } else {
        console.log("❌ Sesi di-logout. Silakan hapus folder 'auth_info_baileys' dan scan ulang QR.");
        io.emit("status", "Disconnected");
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
        if (!text) continue;

        if (processedMsgIds.has(msg.key.id)) continue;
        processedMsgIds.add(msg.key.id);
        if (processedMsgIds.size > 2000) processedMsgIds.clear();

        const targetJid = getBestTargetJid(msg);
        const senderNumber = extractPhoneNumber(targetJid);

        console.log(`📩 [INCOMING CHAT] Sender: ${senderNumber} | Text: ${text}`);

        io.emit("chat-log", {
          time: new Date().toLocaleTimeString(),
          sender: senderNumber,
          text: text,
          type: "in"
        });

        const bufferKey = targetJid;
        if (!messageBuffers.has(bufferKey)) {
          messageBuffers.set(bufferKey, { messages: [], timer: null, targetJid, rawMsg: msg });
        }

        const buf = messageBuffers.get(bufferKey);
        buf.messages.push(text);
        buf.targetJid = targetJid;
        buf.rawMsg = msg;

        if (buf.timer) clearTimeout(buf.timer);

        buf.timer = setTimeout(async () => {
          const aggregatedTexts = [...buf.messages];
          const finalTargetJid = buf.targetJid;
          const finalRawMsg = buf.rawMsg;
          messageBuffers.delete(bufferKey);

          await handleAIBotReply(senderNumber, finalTargetJid, aggregatedTexts.join("\n"), sock, finalRawMsg);
        }, 2000);
      }
    } catch (err) {
      console.error("Upsert Error:", err.message);
    }
  });
}

// --- SOCKET.IO EVENTS ---
io.on("connection", (socket) => {
  socket.emit("status", "Bot Operational");
});

// --- JALANKAN SERVER & BOT ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server BOT WA AI Berjalan di Port ${PORT}`);
  startBot();
});
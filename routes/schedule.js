import express from "express";
import multer from "multer";
import path from "path";
import Schedule from "../models/Schedule.js";
import { getWaSocket } from "../whatsapp/sessionManager.js"; // Sesuaikan lokasi fungsi pengambilan socket WA Anda

const router = express.Router();

// Konfigurasi Multer untuk Upload Media
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// GET /api/schedule/targets - Mengambil Kontak, Grup, dan Channel
router.get("/targets", async (req, res) => {
  try {
    const sock = getWaSocket(req.userId);
    if (!sock) {
      return res.status(400).json({ success: false, message: "WhatsApp tidak terhubung." });
    }

    const targets = [];

    // 1. Ambil Semua Grup
    try {
      const groups = await sock.groupFetchAllParticipating();
      Object.values(groups).forEach((g) => {
        targets.push({
          jid: g.id,
          name: g.subject || "Grup Tanpa Nama",
          type: "group"
        });
      });
    } catch (err) {
      console.warn("Gagal mengambil daftar grup:", err.message);
    }

    // 2. Ambil Kontak Pribadi dari Memory Store / Active Chats
    try {
      if (sock.store && sock.store.chats) {
        const chats = sock.store.chats.all();
        chats.forEach((c) => {
          if (c.id && c.id.endsWith("@s.whatsapp.net")) {
            const numberOnly = c.id.split("@")[0];
            targets.push({
              jid: c.id,
              name: c.name || c.verifiedName || `+${numberOnly}`,
              type: "contact"
            });
          }
        });
      }
    } catch (err) {
      console.warn("Gagal mengambil kontak pribadi:", err.message);
    }

    // 3. Ambil Saluran / Channel (Newsletter)
    try {
      if (typeof sock.newsletterSubscribed === "function") {
        const newsletters = await sock.newsletterSubscribed();
        newsletters.forEach((n) => {
          targets.push({
            jid: n.id,
            name: n.name || "Channel WhatsApp",
            type: "channel"
          });
        });
      }
    } catch (err) {
      console.warn("Gagal mengambil saluran/channel:", err.message);
    }

    return res.json({ success: true, targets });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/schedule/list - Menampilkan Semua Antrian Jadwal User
router.get("/list", async (req, res) => {
  try {
    const schedules = await Schedule.find({ userId: req.userId }).sort({ scheduledTime: 1 });
    return res.json({ success: true, data: schedules });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/schedule/create - Menambahkan Jadwal Pesan Baru
router.post("/create", upload.single("mediaFile"), async (req, res) => {
  try {
    const { targetJid, targetName, targetType, message, scheduledTime, isViewOnce } = req.body;

    if (!targetJid || !scheduledTime) {
      return res.status(400).json({ success: false, message: "Target dan waktu kirim wajib diisi." });
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

    const newSchedule = new Schedule({
      userId: req.userId,
      targetJid,
      targetName: targetName || targetJid.split("@")[0],
      targetType: targetType || "contact",
      message: message || "",
      mediaUrl,
      mediaType,
      isViewOnce: isViewOnce === "true" || isViewOnce === true,
      scheduledTime: new Date(scheduledTime),
      status: "pending"
    });

    await newSchedule.save();
    return res.json({ success: true, message: "Penjadwalan pesan berhasil disimpan!" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/schedule/:id - Menghapus Antrian
router.delete("/:id", async (req, res) => {
  try {
    await Schedule.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    return res.json({ success: true, message: "Penjadwalan berhasil dihapus." });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
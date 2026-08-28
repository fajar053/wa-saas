import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema({
  botUserId: { type: String, required: true }, // ID User Pemilik Bot
  senderNumber: { type: String, required: true }, // Nomor WhatsApp pengirim
  knownName: { type: String, default: null }, // Nama pengirim yang sudah diingat
  messages: [
    {
      role: { type: String, enum: ["user", "assistant"], required: true },
      content: { type: String, required: true },
      timestamp: { type: Date, default: Date.now }
    }
  ],
  lastClearedAt: { type: Date, default: Date.now } // Untuk melacak reset riwayat per 3 hari
}, { timestamps: true });

conversationSchema.index({ botUserId: 1, senderNumber: 1 }, { unique: true });

export default mongoose.model("Conversation", conversationSchema);
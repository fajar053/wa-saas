import mongoose from "mongoose";

const reportSchema = new mongoose.Schema({
  reportId: { 
    type: String, 
    required: true, 
    unique: true 
  },
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User", 
    required: true 
  },
  userEmail: { 
    type: String, 
    required: true 
  },
  userNickname: { 
    type: String 
  },
  category: {
    type: String,
    enum: [
      "Kendala BOT WA Tidak berjalan",
      "Tidak terkoneksi ke WA",
      "Pembayaran Langganan",
      "Auto-Generate Prompt Error",
      "Kuota Bulanan Bermasalah",
      "Respon AI Lambat",
      "Spam Balasan / Duplicate Chat",
      "Masalah Akun & Akses Login",
      "Lainnya"
    ],
    required: true
  },
  subject: { 
    type: String, 
    required: true 
  },
  message: { 
    type: String, 
    required: true 
  },
  status: { 
    type: String, 
    enum: ["Open", "In Progress", "Resolved", "Closed"], 
    default: "Open" 
  },
  adminReply: { 
    type: String, 
    default: "" 
  },
  repliedAt: { 
    type: Date 
  }
}, { timestamps: true });

export default mongoose.model("Report", reportSchema);
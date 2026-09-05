import mongoose from "mongoose";

const scheduleSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  targetJid: { type: String, required: true },
  targetName: { type: String, default: "" },
  targetType: { type: String, enum: ["contact", "group", "channel"], default: "contact" },
  message: { type: String, default: "" },
  mediaUrl: { type: String, default: "" },
  mediaType: { type: String, enum: ["none", "image", "video", "document"], default: "none" },
  isViewOnce: { type: Boolean, default: false },
  scheduledTime: { type: Date, required: true },
  status: { type: String, enum: ["pending", "sent", "failed"], default: "pending" },
  errorMessage: { type: String, default: "" }
}, { timestamps: true });

export default mongoose.model("Schedule", scheduleSchema);
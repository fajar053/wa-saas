import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  apiKey: { type: String, default: "" },
  modelName: { type: String, default: "nvidia/nemotron-3-ultra-550b-a55b:free" },
  systemPrompt: { type: String, default: "Kamu adalah asisten AI yang ramah." },
  isBotActive: { type: Boolean, default: true }, // Status Bot On/Off
  plan: { type: String, enum: ["free", "premium"], default: "free" },
  expiredAt: { type: Date, default: null },
  dailyUsage: {
    count: { type: Number, default: 0 },
    date: { type: String, default: () => new Date().toISOString().split("T")[0] }
  }
}, { timestamps: true });

export default mongoose.model("User", userSchema);
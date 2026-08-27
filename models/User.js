import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  apiKey: { type: String, default: "" },
  modelName: { type: String, default: "google/gemini-2.0-flash-lite-001:free" },
  systemPrompt: { type: String, default: "Kamu adalah asisten AI yang ramah." },
  subscriptionStatus: { type: String, enum: ["free", "pro"], default: "free" },
  expiredAt: { type: Date, default: () => new Date(+new Date() + 7*24*60*60*1000) } // Default trial 7 hari
}, { timestamps: true });

export default mongoose.model("User", userSchema);
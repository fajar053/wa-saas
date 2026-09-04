import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  nickname: { type: String, required: true },
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  profilePicture: { type: String, default: "https://via.placeholder.com/150" },
  isVerified: { type: Boolean, default: false },
  verificationToken: { type: String, default: null },
  resetPasswordToken: { type: String, default: null },
  resetPasswordExpires: { type: Date, default: null },
  role: { type: String, enum: ["user", "admin"], default: "user" },
  openrouterApiKey: { type: String, default: "" },
  orcarouterApiKey: { type: String, default: "" },
  aiProvider: { type: String, enum: ["openrouter", "orcarouter"], default: "openrouter" },
  modelName: { type: String, default: "nvidia/nemotron-3-ultra-550b-a55b:free" },
  googleSpreadsheetId: { type: String, default: "" },
  systemPrompt: { type: String, default: "Kamu adalah asisten AI yang ramah." },
  isBotActive: { type: Boolean, default: true },
  plan: { type: String, enum: ["free", "premium"], default: "free" },
  expiredAt: { type: Date, default: null },
  dailyUsageCount: { type: Number, default: 0 },
  dailyUsageDate: { type: String, default: () => new Date().toISOString().split("T")[0] }
}, { timestamps: true });

export default mongoose.model("User", userSchema);
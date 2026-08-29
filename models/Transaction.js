import mongoose from "mongoose";

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  orderId: { type: String, required: true, unique: true },
  planType: { type: String, enum: ["1_month", "1_year"], default: "1_month" },
  durationDays: { type: Number, default: 30 },
  baseAmount: { type: Number, required: true },
  uniqueCode: { type: Number, required: true },
  totalAmount: { type: Number, required: true },
  status: { type: String, enum: ["pending", "completed", "expired"], default: "pending" },
  createdAt: { type: Date, default: Date.now, expires: 86400 }
});

export default mongoose.model("Transaction", transactionSchema);
import mongoose from "mongoose";

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  orderId: { type: String, required: true, unique: true },
  planType: { type: String, enum: ["1_month", "6_month", "1_year"], required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ["pending", "settlement", "expire", "cancel", "deny"], default: "pending" },
  paymentType: { type: String, default: "qris" },
  snapToken: { type: String }
}, { timestamps: true });

export default mongoose.model("Transaction", transactionSchema);
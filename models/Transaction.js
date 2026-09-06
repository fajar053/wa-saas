import mongoose from "mongoose";

const transactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  orderId: {
    type: String,
    required: true,
    unique: true
  },
  planType: {
    type: String,
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  snapToken: {
    type: String,
    default: ""
  },
  status: {
    type: String,
    enum: ["pending", "pending_manual", "settlement", "capture", "deny", "cancel", "expire", "failure"],
    default: "pending"
  }
}, { timestamps: true });

export default mongoose.models.Transaction || mongoose.model("Transaction", transactionSchema);
import mongoose from "mongoose";

const reportSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  reportId: {
    type: String,
    required: true,
    unique: true
  },
  category: {
    type: String,
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
    enum: ["Pending", "In Progress", "Resolved"],
    default: "Pending"
  },
  adminReply: {
    type: String,
    default: ""
  },
  repliedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

export default mongoose.models.Report || mongoose.model("Report", reportSchema);
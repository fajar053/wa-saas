import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema({
  botUserId: { type: String, required: true },
  senderNumber: { type: String, required: true },
  knownName: { type: String, default: null },
  messages: [
    {
      role: { type: String, enum: ["user", "assistant"], required: true },
      content: { type: String, required: true },
      timestamp: { type: Date, default: Date.now }
    }
  ],
  lastClearedAt: { type: Date, default: Date.now }
});

export default mongoose.model("Conversation", conversationSchema);
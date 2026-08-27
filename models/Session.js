import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  data: { type: String, required: true } // Menyimpan kredensial dalam bentuk teks terenkripsi/JSON
}, { timestamps: true });

export default mongoose.model("Session", sessionSchema);
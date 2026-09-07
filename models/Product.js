// models/Product.js
import mongoose from "mongoose";

const productSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  description: { type: String, default: "" },
  imageUrl: { type: String, default: "" }
}, { timestamps: true });

export default mongoose.model("Product", productSchema);
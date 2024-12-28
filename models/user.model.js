const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  googleId: { type: String, unique: true },
  createdAt: { type: Date, default: Date.now },
  urls: [{ type: mongoose.Schema.Types.ObjectId, ref: "URL" }],
});

const User = mongoose.model("User", userSchema);
module.exports = User;

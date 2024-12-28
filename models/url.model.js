const mongoose = require("mongoose");

const urlSchema = new mongoose.Schema({
  longUrl: { type: String, required: true },
  shortUrl: { type: String, required: true, unique: true },
  topic: String,
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now },
  clicks: [
    {
      userIp: { type: String, required: true },
      userAgent: { type: String, required: true },
      referrer: { type: String },
      timestamp: { type: Date, default: Date.now },
      geolocation: { type: String },
      osType: { type: String },
      deviceType: { type: String },
    },
  ],
});

urlSchema.index({ longUrl: 1 });

const URL = mongoose.model("URL", urlSchema);
module.exports = URL;

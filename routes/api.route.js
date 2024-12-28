const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/user.model");
const authUser = require("../middleware/authUser");
const { generateShortAlias } = require("../utils/generateShortAlias");
const URL = require("../models/url.model");
const userRateLimiter = require("../middleware/userLimiter");

const router = express.Router();
const CLIENT_ID =
  "243032421568-2pgqsg60ul4efo5iab2ggaluapga9qmf.apps.googleusercontent.com";

const client = new OAuth2Client(CLIENT_ID);

router.post("/auth/google", async (req, res) => {
  const id_token = req.headers.authorization.replace("Bearer ", "");
  if (!id_token) {
    return res.status(400).json({ message: "ID token is required" });
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken: id_token,
      audience: CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name } = payload;

    let user = await User.findOne({ googleId });

    if (!user) {
      user = new User({ name, email, googleId });
      await user.save();
    } else {
      user.googleId = googleId;
      await user.save();
    }

    res.status(200).json({ user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

router.post("/shorten", authUser, userRateLimiter, async (req, res) => {
  const { longUrl, customAlias, topic } = req.body;
  const id = req.user._id;

  if (customAlias) {
    const existingAlias = await URL.findOne({ shortUrl: customAlias });
    if (existingAlias) {
      return res.status(400).json({
        message: "Custom alias already exists. Please choose another one.",
      });
    }

    const newURL = new URL({
      longUrl,
      shortUrl: customAlias,
      topic,
      userId: id,
    });
    await newURL.save();
    return res
      .status(201)
      .json({ shortUrl: customAlias, createdAt: newURL.createdAt });
  }

  let shortUrl = generateShortAlias(longUrl);
  let existingURL = await URL.findOne({ shortUrl });

  while (existingURL) {
    shortUrl = generateShortAlias(longUrl + Date.now());
    existingURL = await URL.findOne({ shortUrl });
  }

  const newURL = new URL({
    longUrl,
    shortUrl,
    topic,
    userId: id,
  });

  await newURL.save();

  res.status(201).json({ shortUrl, createdAt: newURL.createdAt });
});

router.get("/shorten/:alias", async (req, res) => {
  const alias = req.params.alias;
  let urlRecord = await URL.findOne({ shortUrl: alias });

  if (!urlRecord) {
    return res.status(404).send("Short URL not found");
  }

  res.redirect(301, urlRecord.longUrl);
});

module.exports = router;

const rateLimit = require("express-rate-limit");

const userRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  message: "Too many URLs created. Please try again later.",
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = userRateLimiter;

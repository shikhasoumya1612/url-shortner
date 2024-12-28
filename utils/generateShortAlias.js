const crypto = require("crypto");

const generateShortAlias = (longUrl) => {
  const hash = crypto.createHash("md5").update(longUrl).digest("base64url");
  return hash.slice(0, 8);
};

module.exports = { generateShortAlias };

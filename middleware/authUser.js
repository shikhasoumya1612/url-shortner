const { OAuth2Client } = require("google-auth-library");
const User = require("../models/user.model");
const CLIENT_ID =
  "243032421568-2pgqsg60ul4efo5iab2ggaluapga9qmf.apps.googleusercontent.com";
const client = new OAuth2Client(CLIENT_ID);

const authUser = async (req, res, next) => {
  try {
    const authorization = req.get("Authorization");
    if (!authorization || !authorization.toLowerCase().startsWith("bearer ")) {
      return res
        .status(401)
        .json({ error: "Authorization header missing or malformed" });
    }
    const idToken = authorization.substring(7);

    const ticket = await client.verifyIdToken({
      idToken,
      audience: CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name } = payload;

    let user = await User.findOne({ googleId });

    if (!user) {
      return res
        .status(401)
        .json({ error: "Authorization header missing or malformed" });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error(error);
    res
      .status(401)
      .json({ error: "Authorization header missing or malformed" });
  }
};

module.exports = authUser;

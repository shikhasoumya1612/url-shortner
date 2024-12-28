const express = require("express");
const dotenv = require("dotenv");
const connectDB = require("./config/db");
const path = require("path");
const useragent = require("express-useragent");
const routes = require("./routes/api.route");

dotenv.config();

connectDB();

const app = express();
app.use(useragent.express());

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use("/api", routes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

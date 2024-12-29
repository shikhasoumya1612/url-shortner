const express = require("express");
const dotenv = require("dotenv");
const connectDB = require("./config/db");
const path = require("path");
const useragent = require("express-useragent");
const routes = require("./routes/api.route");
const swaggerUi = require("swagger-ui-express");
const swaggerJsDoc = require("swagger-jsdoc");
const cors = require("cors");
const worker = require("./workers/click.worker");

dotenv.config();

connectDB();

const app = express();
app.use(useragent.express());
app.use(cors());

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "API Documentation",
      version: "1.0.0",
      description: "API documentation for the application",
    },
    servers: [],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    security: [
      {
        BearerAuth: [],
      },
    ],
  },
  apis: ["./routes/*.js"],
};

app.use((req, res, next) => {
  if (!swaggerOptions.definition.servers.length) {
    const protocol = req.protocol;
    const host = req.get("host");
    swaggerOptions.definition.servers.push({
      url: `${protocol}://${host}`,
    });
  }
  next();
});

const swaggerDocs = swaggerJsDoc(swaggerOptions);

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));
app.use("/api", routes);

worker();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

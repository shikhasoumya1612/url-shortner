const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/user.model");
const authUser = require("../middleware/authUser");
const { generateShortAlias } = require("../utils/generateShortAlias");
const URL = require("../models/url.model");
const userRateLimiter = require("../middleware/userLimiter");
const moment = require("moment");
const axios = require("axios");
const { Queue } = require("bullmq");
const redis = require("redis");
require("dotenv").config("../.env");

const updateQueue = new Queue("urlUpdates", {
  connection: {
    host: process.env.HOST_URL,
    port: 6379,
  },
});

const router = express.Router();
const CLIENT_ID = process.env.GOOGLE_AUTH_CLIENT_API;

const client = new OAuth2Client(CLIENT_ID);

/**
 * @swagger
 * /api/auth/google:
 *   post:
 *     summary: Authenticate using Google OAuth2.0
 *     description: Use Google ID token to authenticate a user and save to the database if not already existing.
 *     operationId: authenticateGoogle
 *     parameters:
 *       - name: Authorization
 *         in: header
 *         required: true
 *         description: The Google ID token passed as a Bearer token in the header.
 *         schema:
 *           type: string
 *           example: "Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6Ijg2Njk2..."
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               data:
 *                 type: string
 *                 example: "Sample Data"
 *     responses:
 *       200:
 *         description: Successfully authenticated user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                       example: "John Doe"
 *                     email:
 *                       type: string
 *                       example: "john.doe@example.com"
 *       400:
 *         description: ID token is required
 *       500:
 *         description: Internal Server Error
 */

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

/**
 * @swagger
 * /api/shorten:
 *   post:
 *     summary: Shorten a URL
 *     description: Shorten a given long URL with an optional custom alias.
 *     operationId: shortenUrl
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               longUrl:
 *                 type: string
 *                 description: The long URL to be shortened
 *                 example: "https://www.example.com"
 *               customAlias:
 *                 type: string
 *                 description: Optional custom alias for the shortened URL
 *                 example: "mycustomalias"
 *               topic:
 *                 type: string
 *                 description: A topic/category related to the URL
 *                 example: "Technology"
 *     responses:
 *       201:
 *         description: URL successfully shortened
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 shortUrl:
 *                   type: string
 *                   example: "short.ly/abcd123"
 *                 createdAt:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-12-28T10:30:00Z"
 *       400:
 *         description: Custom alias already exists
 *       401:
 *         description: User not authenticated
 *       429:
 *         description: Rate limit exceeded
 *       500:
 *         description: Internal Server Error
 */

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
      topic: topic.toLowerCase(),
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
    topic: topic.toLowerCase(),
    userId: id,
  });

  await newURL.save();

  res.status(201).json({ shortUrl, createdAt: newURL.createdAt });
});

/**
 * @swagger
 * /api/shorten/{alias}:
 *   get:
 *     summary: Redirect to the original URL
 *     description: Redirect the user to the original long URL from the shortened alias.
 *     operationId: redirectToOriginalUrl
 *     parameters:
 *       - name: alias
 *         in: path
 *         required: true
 *         description: The alias of the shortened URL
 *         schema:
 *           type: string
 *           example: "abcd123"
 *     responses:
 *       302:
 *         description: Successfully redirected to the original URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 redirectUrl:
 *                   type: string
 *                   example: "https://www.example.com"
 *       404:
 *         description: Alias not found
 *       500:
 *         description: Internal Server Error
 */

const redisClient = redis.createClient({
  host: "127.0.0.1",
  port: 6379,
});
redisClient.on("error", (err) => console.error("Redis Error:", err));

(async () => {
  try {
    await redisClient.connect();
    console.log("Redis client connected");
  } catch (err) {
    console.error("Failed to connect Redis client:", err);
  }
})();

router.get("/shorten/:alias", async (req, res) => {
  const alias = req.params.alias;

  try {
    const cachedUrl = await redisClient.get(alias);
    let urlRecord;

    if (cachedUrl) {
      urlRecord = JSON.parse(cachedUrl);
    } else {
      urlRecord = await URL.findOne({ shortUrl: alias });
      if (!urlRecord) {
        return res.status(404).send("Short URL not found");
      }
      await redisClient.setEx(alias, 3600, JSON.stringify(urlRecord));
    }

    const userIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const userAgent = req.headers["user-agent"];
    let geolocation = "Unknown";

    try {
      const geoResponse = await axios.get(`https://ipinfo.io/${userIp}/geo`, {
        params: { token: process.env.IPINFO_TOKEN },
      });
      geolocation = geoResponse.data.city || "Unknown";
    } catch (geoError) {
      console.error("Error fetching geolocation:", geoError.message);
    }

    const clickData = {
      userIp,
      userAgent,
      timestamp: new Date(),
      geolocation,
      osType: req.useragent?.os || "Unknown OS",
      deviceType: req.useragent?.isMobile
        ? "Mobile"
        : req.useragent?.isTablet
        ? "Tablet"
        : req.useragent?.isDesktop
        ? "Desktop"
        : "Unknown Device",
      shortUrl: alias,
    };

    console.log("Click Data Info - ", clickData);

    await updateQueue.add("updateClick", clickData);

    res.redirect(302, urlRecord.longUrl);
  } catch (error) {
    console.error("Error in route handler:", error);
    res.status(500).send("Internal Server Error");
  }
});

/**
 * @swagger
 * /api/analytics/overall:
 *   get:
 *     summary: Get overall analytics
 *     description: Fetch overall analytics for all URLs created by the authenticated user.
 *     tags: [Analytics]
 *     responses:
 *       200:
 *         description: Analytics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalUrls:
 *                   type: integer
 *                   description: Total number of URLs created by the user
 *                 totalClicks:
 *                   type: integer
 *                   description: Total number of clicks across all URLs
 *                 uniqueUsers:
 *                   type: integer
 *                   description: Number of unique users who clicked the URLs
 *                 clicksByDate:
 *                   type: object
 *                   additionalProperties:
 *                     type: integer
 *                   description: Click counts grouped by date
 *       500:
 *         description: Internal server error
 */

router.get("/analytics/overall", authUser, async (req, res) => {
  try {
    const userId = req.user._id;
    const analytics = await URL.aggregate([
      { $match: { userId } },
      { $unwind: "$clicks" },
      {
        $group: {
          _id: null,
          totalClicks: { $sum: 1 },
          uniqueUsers: { $addToSet: "$clicks.userIp" },
          clicksByDate: {
            $push: {
              date: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$clicks.timestamp",
                },
              },
              totalClicks: 1,
            },
          },
          osType: {
            $push: { osName: "$clicks.osType", userIp: "$clicks.userIp" },
          },
          deviceType: {
            $push: {
              deviceName: "$clicks.deviceType",
              userIp: "$clicks.userIp",
            },
          },
        },
      },
      {
        $project: {
          totalClicks: 1,
          uniqueUsers: { $size: "$uniqueUsers" },
          clicksByDate: 1,
          osType: 1,
          deviceType: 1,
        },
      },
    ]);

    const result = analytics[0] || {
      totalClicks: 0,
      uniqueUsers: 0,
      clicksByDate: [],
      osType: [],
      deviceType: [],
    };

    result.osType = result.osType
      .reduce((acc, click) => {
        const os = acc.find((osItem) => osItem.osName === click.osName);
        if (os) {
          os.uniqueClicks++;
          os.uniqueUsers.add(click.userIp);
        } else {
          acc.push({
            osName: click.osName,
            uniqueClicks: 1,
            uniqueUsers: new Set([click.userIp]),
          });
        }
        return acc;
      }, [])
      .map((os) => ({
        osName: os.osName,
        uniqueClicks: os.uniqueClicks,
        uniqueUsers: os.uniqueUsers.size,
      }));

    result.deviceType = result.deviceType
      .reduce((acc, click) => {
        const device = acc.find(
          (deviceItem) => deviceItem.deviceName === click.deviceName
        );
        if (device) {
          device.uniqueClicks++;
          device.uniqueUsers.add(click.userIp);
        } else {
          acc.push({
            deviceName: click.deviceName,
            uniqueClicks: 1,
            uniqueUsers: new Set([click.userIp]),
          });
        }
        return acc;
      }, [])
      .map((device) => ({
        deviceName: device.deviceName,
        uniqueClicks: device.uniqueClicks,
        uniqueUsers: device.uniqueUsers.size,
      }));

    const groupedClicksByDate = {};
    result.clicksByDate.forEach((data) => {
      if (groupedClicksByDate[data.date])
        groupedClicksByDate[data.date] += data.totalClicks;
      else {
        groupedClicksByDate[data.date] = data.totalClicks;
      }
    });

    result.clicksByDate = groupedClicksByDate;

    res.status(200).json({
      totalUrls: await URL.countDocuments({ userId }),
      totalClicks: result.totalClicks,
      uniqueUsers: result.uniqueUsers,
      clicksByDate: result.clicksByDate,
      osType: result.osType,
      deviceType: result.deviceType,
    });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "An error occurred while retrieving analytics" });
  }
});

/**
 * @swagger
 * /api/topic/{topic}:
 *   get:
 *     summary: Get all shortened URLs by a specific topic
 *     description: Retrieve a list of shortened URLs associated with a specific topic.
 *     operationId: getUrlsByTopic
 *     parameters:
 *       - name: topic
 *         in: path
 *         required: true
 *         description: The topic associated with the shortened URLs
 *         schema:
 *           type: string
 *           example: "Technology"
 *     responses:
 *       200:
 *         description: Successfully retrieved URLs by topic
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   shortUrl:
 *                     type: string
 *                     example: "short.ly/abcd123"
 *                   longUrl:
 *                     type: string
 *                     example: "https://www.example.com"
 *       404:
 *         description: No URLs found for the specified topic
 *       500:
 *         description: Internal Server Error
 */

router.get("/analytics/topic/:topic", async (req, res) => {
  let { topic } = req.params;
  topic = topic.toLowerCase();

  try {
    const analytics = await URL.aggregate([
      { $match: { topic } },
      { $unwind: "$clicks" },
      {
        $group: {
          _id: null,
          totalClicks: { $sum: 1 },
          uniqueUsers: { $addToSet: "$clicks.userIp" },
          clicksByDate: {
            $push: {
              date: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$clicks.timestamp",
                },
              },
              totalClicks: 1,
            },
          },
          osType: {
            $push: { osName: "$clicks.osType", userIp: "$clicks.userIp" },
          },
          deviceType: {
            $push: {
              deviceName: "$clicks.deviceType",
              userIp: "$clicks.userIp",
            },
          },
        },
      },
      {
        $project: {
          totalClicks: 1,
          uniqueUsers: { $size: "$uniqueUsers" },
          clicksByDate: 1,
          osType: 1,
          deviceType: 1,
        },
      },
    ]);

    const result = analytics[0] || {
      totalClicks: 0,
      uniqueUsers: 0,
      clicksByDate: [],
      osType: [],
      deviceType: [],
    };

    result.osType = result.osType
      .reduce((acc, click) => {
        const os = acc.find((osItem) => osItem.osName === click.osName);
        if (os) {
          os.uniqueClicks++;
          os.uniqueUsers.add(click.userIp);
        } else {
          acc.push({
            osName: click.osName,
            uniqueClicks: 1,
            uniqueUsers: new Set([click.userIp]),
          });
        }
        return acc;
      }, [])
      .map((os) => ({
        osName: os.osName,
        uniqueClicks: os.uniqueClicks,
        uniqueUsers: os.uniqueUsers.size,
      }));

    result.deviceType = result.deviceType
      .reduce((acc, click) => {
        const device = acc.find(
          (deviceItem) => deviceItem.deviceName === click.deviceName
        );
        if (device) {
          device.uniqueClicks++;
          device.uniqueUsers.add(click.userIp);
        } else {
          acc.push({
            deviceName: click.deviceName,
            uniqueClicks: 1,
            uniqueUsers: new Set([click.userIp]),
          });
        }
        return acc;
      }, [])
      .map((device) => ({
        deviceName: device.deviceName,
        uniqueClicks: device.uniqueClicks,
        uniqueUsers: device.uniqueUsers.size,
      }));

    const groupedClicksByDate = {};
    result.clicksByDate.forEach((data) => {
      if (groupedClicksByDate[data.date])
        groupedClicksByDate[data.date] += data.totalClicks;
      else {
        groupedClicksByDate[data.date] = data.totalClicks;
      }
    });

    result.clicksByDate = groupedClicksByDate;

    res.status(200).json({
      totalUrls: await URL.countDocuments({ topic }),
      totalClicks: result.totalClicks,
      uniqueUsers: result.uniqueUsers,
      clicksByDate: result.clicksByDate,
      osType: result.osType,
      deviceType: result.deviceType,
    });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "An error occurred while retrieving analytics" });
  }
});

/**
 * @swagger
 * /api/analytics/{alias}:
 *   get:
 *     summary: Get analytics for a specific shortened URL
 *     description: Fetch analytics like the number of times a specific alias has been redirected.
 *     operationId: getAliasAnalytics
 *     parameters:
 *       - name: alias
 *         in: path
 *         required: true
 *         description: The alias of the shortened URL
 *         schema:
 *           type: string
 *           example: "abcd123"
 *     responses:
 *       200:
 *         description: Successfully retrieved analytics for the alias
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 alias:
 *                   type: string
 *                   example: "abcd123"
 *                 redirectCount:
 *                   type: integer
 *                   example: 50
 *       404:
 *         description: Alias not found
 *       500:
 *         description: Internal Server Error
 */

router.get("/analytics/:alias", async (req, res) => {
  const alias = req.params.alias;

  try {
    const urlRecord = await URL.findOne({ shortUrl: alias });

    if (!urlRecord) {
      return res.status(404).json({ message: "Short URL not found" });
    }

    const clicks = urlRecord.clicks;
    const totalClicks = clicks.length;

    const uniqueUsers = new Set(clicks.map((click) => click.userIp)).size;

    const last7Days = [...Array(7).keys()].map((i) =>
      moment().subtract(i, "days").format("YYYY-MM-DD")
    );

    const clicksByDate = last7Days.map((date) => ({
      date,
      clickCount: clicks.filter(
        (click) => moment(click.timestamp).format("YYYY-MM-DD") === date
      ).length,
    }));

    const osTypeMap = {};
    clicks.forEach((click) => {
      if (!osTypeMap[click.osType]) {
        osTypeMap[click.osType] = { uniqueClicks: 0, users: new Set() };
      }
      osTypeMap[click.osType].uniqueClicks += 1;
      osTypeMap[click.osType].users.add(click.userIp);
    });

    const osType = Object.keys(osTypeMap).map((os) => ({
      osName: os,
      uniqueClicks: osTypeMap[os].uniqueClicks,
      uniqueUsers: osTypeMap[os].users.size,
    }));

    const deviceTypeMap = {};
    clicks.forEach((click) => {
      if (!deviceTypeMap[click.deviceType]) {
        deviceTypeMap[click.deviceType] = { uniqueClicks: 0, users: new Set() };
      }
      deviceTypeMap[click.deviceType].uniqueClicks += 1;
      deviceTypeMap[click.deviceType].users.add(click.userIp);
    });

    const deviceType = Object.keys(deviceTypeMap).map((device) => ({
      deviceName: device,
      uniqueClicks: deviceTypeMap[device].uniqueClicks,
      uniqueUsers: deviceTypeMap[device].users.size,
    }));

    res.status(200).json({
      totalClicks,
      uniqueUsers,
      clicksByDate,
      osType,
      deviceType,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

module.exports = router;

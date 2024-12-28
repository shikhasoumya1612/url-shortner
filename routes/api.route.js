const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/user.model");
const authUser = require("../middleware/authUser");
const { generateShortAlias } = require("../utils/generateShortAlias");
const URL = require("../models/url.model");
const userRateLimiter = require("../middleware/userLimiter");
const moment = require("moment");
const useragent = require("useragent");
const axios = require("axios");

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

router.get("/shorten/:alias", async (req, res) => {
  const alias = req.params.alias;

  try {
    const urlRecord = await URL.findOne({ shortUrl: alias });

    if (!urlRecord) {
      return res.status(404).send("Short URL not found");
    }

    const userIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const userAgent = req.headers["user-agent"];

    try {
      const geoResponse = await axios.get(`https://ipinfo.io/${userIp}/geo`, {
        params: { token: process.env.IPINFO_TOKEN },
      });
      geolocation = geoResponse.data.city || "Unknown";
    } catch (geoError) {
      console.error("Error fetching geolocation:", geoError.message);
    }

    urlRecord.clicks.push({
      userIp,
      userAgent,
      timestamp: new Date(),
      geolocation: geolocation.city || "Unknown",
      osType: req.useragent?.os || "Unknown OS",
      deviceType: req.useragent?.isMobile
        ? "Mobile"
        : req.useragent?.isTablet
        ? "Tablet"
        : req.useragent?.isDesktop
        ? "Desktop"
        : "Unknown Device",
    });

    await urlRecord.save();

    res.redirect(301, urlRecord.longUrl);
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
});

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
          uniqueUsers: { $addToSet: "$clicks.userIp" }, // Collect unique user IPs
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

router.get("/analytics/topic/:topic", async (req, res) => {
  const { topic } = req.params;

  try {
    const analytics = await URL.aggregate([
      { $match: { topic } },
      { $unwind: "$clicks" },
      {
        $group: {
          _id: null,
          totalClicks: { $sum: 1 },
          uniqueUsers: { $addToSet: "$clicks.userIp" }, // Collect unique user IPs
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

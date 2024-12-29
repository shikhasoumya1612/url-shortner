const { Worker } = require("bullmq");
const URL = require("../models/url.model");

const worker = () => {
  const worker = new Worker(
    "urlUpdates",
    async (job) => {
      const {
        userIp,
        userAgent,
        timestamp,
        geolocation,
        osType,
        deviceType,
        shortUrl,
      } = job.data;

      try {
        const urlRecord = await URL.findOne({ shortUrl });

        if (urlRecord) {
          urlRecord.clicks.push({
            userIp,
            userAgent,
            timestamp,
            geolocation,
            osType,
            deviceType,
          });
          await urlRecord.save();
          console.log(`Updated clicks for URL: ${shortUrl}`);
        } else {
          console.error(`URL not found in the database for alias: ${shortUrl}`);
        }
      } catch (error) {
        console.error("Error processing database update:", error);
      }
    },
    {
      connection: {
        host: "127.0.0.1",
        port: 6379,
      },
    }
  );

  worker.on("completed", (job) => {
    console.log(`Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`Job ${job.id} failed with error: ${err.message}`);
  });

  console.log("Worker for saving click data started");
};

module.exports = worker;

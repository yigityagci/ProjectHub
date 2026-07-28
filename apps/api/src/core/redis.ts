import { Redis } from "ioredis";
import { env } from "../config/env.js";

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

redis.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("Redis connection error:", err.message);
});

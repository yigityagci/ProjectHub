/**
 * Vitest globalSetup: runs once (in a separate process) before the entire
 * test run starts. Used to flush the test Redis instance so leftover
 * rate-limit counters from a previous run don't bleed into this one.
 */
export default async function globalSetup() {
  process.env.NODE_ENV = "test";
  const { Redis } = await import("ioredis");
  const url = process.env.REDIS_URL ?? "redis://127.0.0.1:56379";
  const redis = new Redis(url);
  await redis.flushdb();
  await redis.quit();
}

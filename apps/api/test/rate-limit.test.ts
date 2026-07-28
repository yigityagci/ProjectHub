import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// This file deliberately overrides RATE_LIMIT_LOGIN_MAX to a small value
// and imports the app modules dynamically (after setting process.env), so
// its low limit doesn't affect any other test file's shared Redis-backed
// rate-limit counters. Every module that (transitively) reads `env` at
// import time must be reached only via this dynamic import, not a static
// top-level import.
process.env.RATE_LIMIT_LOGIN_MAX = "5";
process.env.RATE_LIMIT_LOGIN_WINDOW_MINUTES = "15";

describe("Login rate limiting", () => {
  let app: FastifyInstance;
  let helpers: typeof import("./helpers.js");

  beforeAll(async () => {
    helpers = await import("./helpers.js");
    app = await helpers.createTestApp();
    await helpers.resetDatabase();
    // Ensure no stale rate-limit counters from anything else sharing this
    // Redis instance affect this file's own low-limit assertions.
    const { redis } = await import("../src/core/redis.js");
    await redis.flushdb();

    const anon = helpers.freshClient(app);
    await anon.post("/api/auth/register", {
      email: "ratelimited@example.com",
      password: helpers.VALID_PASSWORD,
      displayName: "Rate Limited",
    });
  });
  afterAll(async () => {
    await helpers.closeTestApp(app);
    await helpers.disconnectAll();
  });

  it("blocks repeated failed login attempts with 429", async () => {
    const max = 5;
    let lastStatus = 0;
    for (let i = 0; i < max + 3; i++) {
      const client = helpers.freshClient(app);
      const res = await client.post("/api/auth/login", {
        email: "ratelimited@example.com",
        password: "WrongPassword1!",
      });
      lastStatus = res.statusCode;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});

import type { FastifyInstance } from "fastify";
import { prisma } from "./prisma.js";
import { redis } from "./redis.js";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness: no dependency checks, always 200. Unauthenticated & rate-limit-exempt.
  app.get(
    "/health",
    { config: { rateLimit: false }, schema: { hide: true } },
    async () => ({ status: "ok" }),
  );

  // Readiness: checks Postgres + Redis. Unauthenticated & rate-limit-exempt.
  // No internal detail beyond up/down is exposed.
  app.get(
    "/health/ready",
    { config: { rateLimit: false }, schema: { hide: true } },
    async (_req, reply) => {
      let dbUp = false;
      let redisUp = false;

      try {
        await prisma.$queryRaw`SELECT 1`;
        dbUp = true;
      } catch {
        dbUp = false;
      }

      try {
        const pong = await redis.ping();
        redisUp = pong === "PONG";
      } catch {
        redisUp = false;
      }

      if (dbUp && redisUp) {
        return { status: "ok" };
      }

      return reply.code(503).send({ status: "unavailable" });
    },
  );
}

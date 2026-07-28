import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { pinoOptions } from "./core/logger.js";
import { redis } from "./core/redis.js";
import { AppError } from "./core/errors.js";
import { registerHealthRoutes } from "./core/health.js";
import { registerOpenApi } from "./openapi.js";
import { registerAuthRoutes } from "./auth/auth.routes.js";
import { registerSetupRoutes } from "./auth/setup.routes.js";
import { registerWorkspaceRoutes } from "./workspaces/workspaces.routes.js";
import { registerMemberRoutes } from "./workspaces/members.routes.js";
import { registerInvitationRoutes } from "./workspaces/invitations.routes.js";
import { registerProjectRoutes } from "./projects/projects.routes.js";
import { registerColumnRoutes } from "./projects/columns.routes.js";
import { registerTaskRoutes } from "./projects/tasks.routes.js";
import { registerLabelRoutes } from "./projects/labels.routes.js";
import { registerMilestoneRoutes } from "./projects/milestones.routes.js";
import { registerCommentRoutes } from "./comments/comments.routes.js";
import { registerAttachmentRoutes } from "./attachments/attachments.routes.js";
import { registerNotificationRoutes } from "./notifications/notifications.routes.js";
import { registerActivityRoutes } from "./activity/activity.routes.js";
import { registerAnalyticsRoutes } from "./analytics/analytics.routes.js";
import { initRealtime } from "./realtime/realtime.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: pinoOptions,
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
  });

  app.addHook("onRequest", async (req) => {
    req.ctx = {};
  });

  await app.register(sensible);
  await app.register(cookie);
  await app.register(helmet, {
    // Self-hosted SPA served separately; keep CSP conservative but out of
    // the way of the API's JSON responses.
    contentSecurityPolicy: false,
  });
  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(",").map((o) => o.trim()),
    credentials: true,
  });
  await app.register(multipart, {
    limits: {
      fileSize: env.UPLOAD_MAX_SIZE_BYTES,
      files: 1,
    },
  });
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: `${env.RATE_LIMIT_GLOBAL_WINDOW_MINUTES} minutes`,
    redis,
    skipOnError: true,
    allowList: (req) => req.url === "/health" || req.url === "/health/ready",
  });

  await registerOpenApi(app);

  app.setErrorHandler((error: Error & { statusCode?: number }, req, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId: req.id },
      });
    }

    if (error instanceof ZodError) {
      return reply.code(422).send({
        error: {
          code: "VALIDATION_ERROR",
          message: error.issues[0]?.message ?? "Invalid input.",
          requestId: req.id,
        },
      });
    }

    // Fastify validation errors (schema-based) and rate-limit errors carry
    // their own statusCode; pass those through generically.
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;

    if (statusCode === 429) {
      return reply.code(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "Too many login attempts. Please try again in 15 minutes.",
          requestId: req.id,
        },
      });
    }

    req.log.error({ err: error }, "Unhandled error");

    const message =
      env.NODE_ENV === "production" || statusCode < 500
        ? statusCode < 500
          ? error.message
          : "An unexpected error occurred. Please try again later."
        : error.message;

    return reply.code(statusCode >= 400 ? statusCode : 500).send({
      error: { code: "INTERNAL_ERROR", message, requestId: req.id },
    });
  });

  await registerHealthRoutes(app);
  await registerSetupRoutes(app);
  await registerAuthRoutes(app);
  await registerWorkspaceRoutes(app);
  await registerMemberRoutes(app);
  await registerInvitationRoutes(app);
  await registerProjectRoutes(app);
  await registerColumnRoutes(app);
  await registerTaskRoutes(app);
  await registerLabelRoutes(app);
  await registerMilestoneRoutes(app);
  await registerCommentRoutes(app);
  await registerAttachmentRoutes(app);
  await registerNotificationRoutes(app);
  await registerActivityRoutes(app);
  await registerAnalyticsRoutes(app);

  initRealtime(app);

  return app;
}

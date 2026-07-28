import type { FastifyInstance } from "fastify";
import { registerSchema, loginSchema } from "@projecthub/shared";
import { env } from "../config/env.js";
import { prisma } from "../core/prisma.js";
import { ValidationError, UnauthorizedError } from "../core/errors.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import {
  registerUser,
  findUserByEmail,
  GENERIC_LOGIN_FAILURE_MESSAGE,
} from "./auth.service.js";
import { verifyPassword, getDummyHash } from "./password.js";
import {
  createSession,
  setSessionCookie,
  setCsrfCookie,
  clearSessionCookie,
  revokeSession,
} from "./session.js";
import { requireAuth, requireCsrf } from "../rbac/guards.js";
import { toAuthenticatedUser } from "../rbac/context.js";
import { NotFoundError } from "../core/errors.js";

const LOGIN_RATE_LIMIT = {
  max: env.RATE_LIMIT_LOGIN_MAX,
  timeWindow: `${env.RATE_LIMIT_LOGIN_WINDOW_MINUTES} minutes`,
};

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/auth/register",
    { config: { rateLimit: LOGIN_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }

      const user = await registerUser(parsed.data);

      return reply.code(201).send({
        user: toAuthenticatedUser(user),
      });
    },
  );

  app.post(
    "/api/auth/login",
    { config: { rateLimit: LOGIN_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { email, password } = parsed.data;

      const user = await findUserByEmail(email);

      // Always perform a hash comparison, even for unknown emails, so
      // response timing does not signal whether the account exists.
      const hashToCompare = user?.passwordHash ?? (await getDummyHash());
      const passwordOk = await verifyPassword(hashToCompare, password);

      if (!user || !passwordOk || user.status !== "active") {
        await recordAuditEvent({
          action: "login.failed",
          metadata: { emailAttempted: email.slice(0, 320) },
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
        throw new UnauthorizedError(GENERIC_LOGIN_FAILURE_MESSAGE);
      }

      const session = await createSession({
        userId: user.id,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      setSessionCookie(reply, session.rawToken, session.expiresAt);
      setCsrfCookie(reply);

      await recordAuditEvent({
        actorId: user.id,
        action: "login.succeeded",
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send({ user: toAuthenticatedUser(user) });
    },
  );

  app.post(
    "/api/auth/logout",
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      if (req.ctx.sessionId) {
        await revokeSession(req.ctx.sessionId);
      }
      clearSessionCookie(reply);
      return reply.send({ ok: true });
    },
  );

  app.get("/api/auth/me", { preHandler: [requireAuth] }, async (req, reply) => {
    return reply.send({ user: req.ctx.user });
  });

  app.get("/api/auth/sessions", { preHandler: [requireAuth] }, async (req, reply) => {
    const sessions = await prisma.session.findMany({
      where: { userId: req.ctx.user!.id, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        lastSeenAt: true,
        ip: true,
        userAgent: true,
      },
    });
    return reply.send({ sessions });
  });

  app.post(
    "/api/auth/sessions/:id/revoke",
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const session = await prisma.session.findUnique({ where: { id } });

      if (!session || session.userId !== req.ctx.user!.id) {
        // Don't leak existence of another user's session.
        throw new NotFoundError("Session not found.");
      }

      await revokeSession(session.id);
      await recordAuditEvent({
        actorId: req.ctx.user!.id,
        action: "session.revoked",
        targetType: "Session",
        targetId: session.id,
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send({ ok: true });
    },
  );

  // Issues/refreshes the CSRF cookie for the current browsing session so
  // frontend clients that lost the in-memory token (e.g. after reload)
  // can re-read it from the (non-httpOnly) cookie before their next
  // mutating request.
  app.get("/api/auth/csrf", async (_req, reply) => {
    setCsrfCookie(reply);
    return reply.send({ ok: true });
  });
}

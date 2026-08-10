import type { FastifyInstance } from "fastify";
import {
  registerSchema,
  loginSchema,
  requestPasswordResetSchema,
  confirmPasswordResetSchema,
} from "@projecthub/shared";
import { env } from "../config/env.js";
import { prisma } from "../core/prisma.js";
import { logger } from "../core/logger.js";
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
import {
  issuePasswordResetToken,
  consumePasswordResetToken,
  buildPasswordResetLink,
} from "./password-reset.service.js";
import { sendPasswordResetEmail } from "../email/email.service.js";
import { requireAuth, requireCsrf, requireSessionAuth } from "../rbac/guards.js";
import { toAuthenticatedUser } from "../rbac/context.js";
import { NotFoundError } from "../core/errors.js";
import { serializeUserSettings } from "./account.service.js";

// Exported so account.routes.ts (email/password change) can reuse the same
// rate limit to blunt online guessing of currentPassword from a hijacked
// session, rather than declaring a second identical constant.
export const LOGIN_RATE_LIMIT = {
  max: env.RATE_LIMIT_LOGIN_MAX,
  timeWindow: `${env.RATE_LIMIT_LOGIN_WINDOW_MINUTES} minutes`,
};

const PASSWORD_RESET_RATE_LIMIT = {
  max: env.RATE_LIMIT_PASSWORD_RESET_MAX,
  timeWindow: `${env.RATE_LIMIT_PASSWORD_RESET_WINDOW_MINUTES} minutes`,
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

      const { user, workspace, role } = await registerUser(parsed.data);

      await recordAuditEvent({
        workspaceId: workspace.id,
        actorId: user.id,
        action: "user.registered",
        targetType: "User",
        targetId: user.id,
        metadata: { roleKey: role.key },
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.code(201).send({
        user: toAuthenticatedUser(user),
        workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
        role: role.key,
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
    "/api/auth/password-reset/request",
    { config: { rateLimit: PASSWORD_RESET_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = requestPasswordResetSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { email } = parsed.data;

      const rawToken = await issuePasswordResetToken(email);

      if (rawToken) {
        const resetLink = buildPasswordResetLink(rawToken);
        // Fire-and-forget: response latency must stay constant regardless
        // of whether an account exists, so the caller never awaits mail
        // delivery before responding (the anti-enumeration timing control).
        void sendPasswordResetEmail({
          recipientEmail: email,
          resetLink,
          ttlHours: env.PASSWORD_RESET_TTL_HOURS,
        }).catch((err) => {
          logger.error({ err }, "Failed to send password reset email");
        });

        const user = await findUserByEmail(email);
        // Only audit when a real user was matched, so the audit log
        // itself doesn't become an enumeration oracle.
        await recordAuditEvent({
          actorId: user?.id ?? null,
          action: "password_reset.requested",
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
      }

      // Always return the same generic response, whether or not the email
      // matched a user — this is the primary anti-enumeration control.
      return reply.send({ ok: true });
    },
  );

  app.post(
    "/api/auth/password-reset/confirm",
    { config: { rateLimit: PASSWORD_RESET_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = confirmPasswordResetSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const { token, password } = parsed.data;

      const { userId } = await consumePasswordResetToken({ rawToken: token, newPassword: password });

      await recordAuditEvent({
        actorId: userId,
        action: "password_reset.completed",
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send({ ok: true });
    },
  );

  app.post(
    "/api/auth/logout",
    { preHandler: [requireAuth, requireCsrf, requireSessionAuth] },
    async (req, reply) => {
      if (req.ctx.sessionId) {
        await revokeSession(req.ctx.sessionId);
      }
      clearSessionCookie(reply);
      return reply.send({ ok: true });
    },
  );

  app.get("/api/auth/me", { preHandler: [requireAuth] }, async (req, reply) => {
    // The base req.ctx.user (from requireAuth) intentionally carries only
    // AuthenticatedUser's small field set; Settings needs the full row.
    // Confined to this one route — accepted as negligible extra cost rather
    // than widening AuthenticatedUser/RequestContext everywhere.
    const user = await prisma.user.findUnique({ where: { id: req.ctx.user!.id } });
    if (!user) throw new UnauthorizedError();
    return reply.send({ user: serializeUserSettings(user) });
  });

  app.get("/api/auth/sessions", { preHandler: [requireAuth, requireSessionAuth] }, async (req, reply) => {
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
    return reply.send({
      sessions: sessions.map((s) => ({ ...s, current: s.id === req.ctx.sessionId })),
    });
  });

  app.post(
    "/api/auth/sessions/:id/revoke",
    { preHandler: [requireAuth, requireCsrf, requireSessionAuth] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const session = await prisma.session.findUnique({ where: { id } });

      if (!session || session.userId !== req.ctx.user!.id) {
        // Don't leak existence of another user's session.
        throw new NotFoundError("Session not found.");
      }

      await revokeSession(session.id);

      // Revoking your own current session is, server-side, indistinguishable
      // from a manual logout — clear the cookie so this request's response
      // leaves the browser logged out immediately (the frontend separately
      // redirects to /login on this same condition).
      if (session.id === req.ctx.sessionId) {
        clearSessionCookie(reply);
      }

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

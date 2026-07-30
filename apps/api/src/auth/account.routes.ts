import type { FastifyInstance } from "fastify";
import {
  updateProfileSchema,
  updatePreferencesSchema,
  changeEmailSchema,
  changePasswordSchema,
} from "@projecthub/shared";
import { ValidationError } from "../core/errors.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requireAuth, requireCsrf } from "../rbac/guards.js";
import { updateProfile, updatePreferences, changeEmail, changePassword } from "./account.service.js";
import { LOGIN_RATE_LIMIT } from "./auth.routes.js";

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.patch(
    "/api/auth/me/profile",
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const parsed = updateProfileSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const user = await updateProfile(req.ctx.user!.id, parsed.data);
      return reply.send({ user });
    },
  );

  app.patch(
    "/api/auth/me/preferences",
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const parsed = updatePreferencesSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const user = await updatePreferences(req.ctx.user!.id, parsed.data);
      return reply.send({ user });
    },
  );

  app.post(
    "/api/auth/email/change",
    { config: { rateLimit: LOGIN_RATE_LIMIT }, preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const parsed = changeEmailSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }

      try {
        const user = await changeEmail({
          userId: req.ctx.user!.id,
          currentSessionId: req.ctx.sessionId!,
          currentPassword: parsed.data.currentPassword,
          newEmail: parsed.data.newEmail,
        });
        await recordAuditEvent({
          actorId: req.ctx.user!.id,
          action: "email_change.completed",
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
        return reply.send({ user });
      } catch (err) {
        await recordAuditEvent({
          actorId: req.ctx.user!.id,
          action: "email_change.failed",
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
        throw err;
      }
    },
  );

  app.post(
    "/api/auth/password/change",
    { config: { rateLimit: LOGIN_RATE_LIMIT }, preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }

      try {
        await changePassword({
          userId: req.ctx.user!.id,
          currentSessionId: req.ctx.sessionId,
          currentPassword: parsed.data.currentPassword,
          newPassword: parsed.data.newPassword,
        });
        await recordAuditEvent({
          actorId: req.ctx.user!.id,
          action: "password_change.completed",
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
        return reply.send({ ok: true });
      } catch (err) {
        await recordAuditEvent({
          actorId: req.ctx.user!.id,
          action: "password_change.failed",
          ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
        });
        throw err;
      }
    },
  );
}

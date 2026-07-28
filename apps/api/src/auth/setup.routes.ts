import type { FastifyInstance } from "fastify";
import { setupSchema } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { ValidationError, ConflictError } from "../core/errors.js";
import { hashPassword } from "./password.js";
import { createSession, setSessionCookie, setCsrfCookie } from "./session.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { toAuthenticatedUser } from "../rbac/context.js";
import { normalizeEmail } from "./auth.service.js";

const ALREADY_COMPLETED_MESSAGE = "Setup has already been completed.";

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/setup/status", { config: { rateLimit: false } }, async (_req, reply) => {
    const count = await prisma.user.count();
    return reply.send({ needsSetup: count === 0 });
  });

  app.post("/api/setup", async (req, reply) => {
    const parsed = setupSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    const { email, password, displayName } = parsed.data;

    // Re-checked inside a Serializable transaction to prevent a race
    // between two concurrent setup attempts. After the first user exists,
    // this endpoint permanently refuses to create another "first admin".
    let user;
    try {
      user = await prisma.$transaction(
        async (tx) => {
          const existingCount = await tx.user.count();
          if (existingCount > 0) {
            throw new ConflictError(ALREADY_COMPLETED_MESSAGE);
          }

          const passwordHash = await hashPassword(password);
          return tx.user.create({
            data: {
              email: normalizeEmail(email),
              passwordHash,
              displayName,
              isPlatformAdmin: true,
            },
          });
        },
        { isolationLevel: "Serializable" },
      );
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      // A serialization conflict here means another concurrent setup
      // attempt raced us; treat it the same as "already completed".
      throw new ConflictError(ALREADY_COMPLETED_MESSAGE);
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
      action: "admin.setup.completed",
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    });

    return reply.code(201).send({ user: toAuthenticatedUser(user) });
  });
}

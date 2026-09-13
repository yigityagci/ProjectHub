import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { setupSchema } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { ValidationError, ConflictError } from "../core/errors.js";
import { hashPassword } from "./password.js";
import { createSession, setSessionCookie, setCsrfCookie } from "./session.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { toAuthenticatedUser } from "../rbac/context.js";
import { normalizeEmail } from "./auth.service.js";
import { createWorkspace } from "../workspaces/workspaces.service.js";

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
    //
    // The auto-created workspace (see createWorkspace call below) lives in
    // this SAME transaction, not a separate one after it commits: setup
    // must be all-or-nothing. Otherwise a failure between the two writes
    // (e.g. a DB hiccup) would permanently strand an admin user with no
    // workspace — `needsSetup` would already read false (a user exists),
    // so POST /api/setup could never be retried, and the only recovery
    // would be an undocumented manual detour through WorkspacesPage.
    let user;
    try {
      user = await prisma.$transaction(
        async (tx) => {
          const existingCount = await tx.user.count();
          if (existingCount > 0) {
            throw new ConflictError(ALREADY_COMPLETED_MESSAGE);
          }

          const passwordHash = await hashPassword(password);
          const createdUser = await tx.user.create({
            data: {
              email: normalizeEmail(email),
              passwordHash,
              displayName,
              isPlatformAdmin: true,
            },
          });

          // Single-tenant self-hosted instances have no reason to make the
          // admin manually create a workspace before doing anything else —
          // auto-create one and make them its OWNER, reusing createWorkspace's
          // existing role + permission seeding. Name is a placeholder:
          // renameable immediately afterward from Settings > Manage Team
          // (workspace.settings.manage).
          await createWorkspace(
            {
              name: "My Workspace",
              slug: `workspace-${crypto.randomBytes(4).toString("hex")}`,
              ownerId: createdUser.id,
            },
            tx,
          );

          return createdUser;
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

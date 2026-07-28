import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../core/prisma.js";
import { UnauthorizedError, NotFoundError, ForbiddenError } from "../core/errors.js";
import { getRawSessionToken, resolveSession, CSRF_COOKIE_NAME } from "../auth/session.js";
import { toAuthenticatedUser } from "./context.js";

/**
 * Requires a valid, non-expired, non-revoked session. Populates
 * req.ctx.user and req.ctx.sessionId. Permissions are intentionally NOT
 * cached on the session — requireMembership loads them fresh per request.
 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const rawToken = getRawSessionToken(req);
  if (!rawToken) {
    throw new UnauthorizedError();
  }

  const session = await resolveSession(rawToken);
  if (!session) {
    throw new UnauthorizedError();
  }

  req.ctx = req.ctx ?? {};
  req.ctx.user = toAuthenticatedUser(session.user);
  req.ctx.sessionId = session.id;
}

/**
 * CSRF protection via the double-submit cookie pattern: a non-httpOnly
 * cookie value must be echoed back in the X-CSRF-Token header on every
 * state-changing (non-GET/HEAD/OPTIONS) request.
 */
export async function requireCsrf(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const cookieToken = req.cookies[CSRF_COOKIE_NAME];
  const headerToken = req.headers["x-csrf-token"];

  if (!cookieToken || !headerToken || Array.isArray(headerToken) || cookieToken !== headerToken) {
    throw new UnauthorizedError("Missing or invalid CSRF token.");
  }
}

/**
 * Loads the caller's active membership (with role + permissions) for the
 * `:workspaceId` route param. Missing/inactive membership -> 404 (never
 * 403) so that unauthorized callers cannot distinguish "doesn't exist"
 * from "exists but you're not in it".
 */
export async function requireMembership(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.ctx?.user) {
    throw new UnauthorizedError();
  }

  const params = req.params as Record<string, string | undefined>;
  const workspaceId = params.workspaceId;
  if (!workspaceId) {
    throw new NotFoundError("This workspace doesn't exist or you don't have access to it.");
  }

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) {
    throw new NotFoundError("This workspace doesn't exist or you don't have access to it.");
  }

  const membership = await prisma.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: req.ctx.user.id } },
    include: { role: { include: { permissions: true } } },
  });

  if (!membership || membership.status !== "active") {
    throw new NotFoundError("This workspace doesn't exist or you don't have access to it.");
  }

  req.ctx.workspace = workspace;
  req.ctx.membership = membership;
  req.ctx.permissions = new Set(membership.role.permissions.map((p) => p.permission));
}

/**
 * Factory: requires the given permission to be present in the fresh
 * per-request permission set loaded by requireMembership. Permissions are
 * never cached in the session/cookie, so role changes take effect on the
 * very next request.
 */
export function requirePermission(permission: string) {
  return async function permissionGuard(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!req.ctx?.permissions?.has(permission)) {
      throw new ForbiddenError();
    }
  };
}

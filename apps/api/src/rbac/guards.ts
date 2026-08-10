import type { FastifyReply, FastifyRequest } from "fastify";
import { ROLE_RANK, type RoleKey } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { UnauthorizedError, NotFoundError, ForbiddenError } from "../core/errors.js";
import { getRawSessionToken, resolveSession, CSRF_COOKIE_NAME } from "../auth/session.js";
import { resolveAgentToken } from "../auth/agent-token.service.js";
import { toAuthenticatedUser } from "./context.js";

const PROJECT_NOT_FOUND_MESSAGE = "This project doesn't exist or you don't have access to it.";
const CATEGORY_NOT_FOUND_MESSAGE = "This category doesn't exist or you don't have access to it.";

/**
 * Extracts the raw bearer value from an `Authorization: Bearer <token>`
 * header, or `null` if the header is absent or uses a different scheme
 * (e.g. `Basic`, which a reverse proxy might attach) — a purely
 * syntax-level, no-DB-lookup decision, made BEFORE resolving anything.
 */
function extractBearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || Array.isArray(header)) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !match[1]) return null;
  return match[1].trim();
}

/**
 * Requires a valid, non-expired, non-revoked credential — EITHER a session
 * cookie OR an `Authorization: Bearer <agentToken>` header — producing an
 * identical req.ctx.user shape either way so every downstream guard stays
 * completely unchanged.
 *
 * The Bearer-scheme check happens FIRST, decided from request syntax alone
 * (no DB lookup), before any cookie handling. If a Bearer-scheme
 * Authorization header is present, this is a deliberate, fail-closed
 * decision point with NO fallback to cookie auth on failure: an unknown,
 * revoked, expired, or inactive-owner token throws immediately. This
 * no-fallback property is exactly what makes requireCsrf's agent-token
 * exemption safe (see requireCsrf below) — there is no path where a request
 * that merely happens to lack a valid bearer token gets silently
 * reauthenticated via cookie and treated as CSRF-exempt.
 *
 * If no Bearer-scheme header is present (including a non-Bearer scheme,
 * e.g. `Basic`), this falls through to the existing cookie-based session
 * flow, unchanged.
 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  req.ctx = req.ctx ?? {};

  const bearerToken = extractBearerToken(req);
  if (bearerToken !== null) {
    const resolved = await resolveAgentToken(bearerToken);
    if (!resolved) {
      throw new UnauthorizedError();
    }

    req.ctx.user = {
      id: resolved.user.id,
      email: resolved.user.email,
      displayName: resolved.user.displayName,
      isPlatformAdmin: resolved.user.isPlatformAdmin,
    };
    req.ctx.authMethod = "agent_token";
    req.ctx.agentToken = { id: resolved.id, label: resolved.label };
    return;
  }

  const rawToken = getRawSessionToken(req);
  if (!rawToken) {
    throw new UnauthorizedError();
  }

  const session = await resolveSession(rawToken);
  if (!session) {
    throw new UnauthorizedError();
  }

  req.ctx.user = toAuthenticatedUser(session.user);
  req.ctx.authMethod = "session";
  req.ctx.sessionId = session.id;
}

/**
 * CSRF protection via the double-submit cookie pattern: a non-httpOnly
 * cookie value must be echoed back in the X-CSRF-Token header on every
 * state-changing (non-GET/HEAD/OPTIONS) request.
 *
 * Skips ONLY when `req.ctx.authMethod === "agent_token"` — this positive,
 * specific condition, never "the cookie happens to be missing" and never
 * "authMethod is undefined" (undefined means requireAuth didn't run, or ran
 * and matched neither path — CSRF stays enforced, fail-closed). A browser
 * cannot be tricked into attaching an Authorization header cross-origin
 * (unlike a cookie), so double-submit CSRF defends against nothing for
 * Bearer-authenticated requests — but ONLY because requireAuth's
 * agent-token path (above) never falls back to cookie auth on failure; see
 * its doc comment.
 */
export async function requireCsrf(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  if (req.ctx?.authMethod === "agent_token") return;

  const cookieToken = req.cookies[CSRF_COOKIE_NAME];
  const headerToken = req.headers["x-csrf-token"];

  if (!cookieToken || !headerToken || Array.isArray(headerToken) || cookieToken !== headerToken) {
    throw new UnauthorizedError("Missing or invalid CSRF token.");
  }
}

/**
 * Fail-closed gate for routes that must remain agent-token-UNREACHABLE:
 * minting/managing bearer credentials of any kind (agent tokens,
 * registration tokens), platform administration, and account-recovery-
 * sensitive routes (email/password change) — a leaked agent token minting
 * infinite replacement credentials would defeat "Revoke" as a security
 * control, and some of these routes (email change) rely on
 * `req.ctx.sessionId`, which is undefined on the bearer path. Throws 403
 * unless the caller authenticated via a session cookie.
 */
export async function requireSessionAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (req.ctx?.authMethod !== "session") {
    throw new ForbiddenError();
  }
}

/**
 * Used ONLY by the MCP endpoint itself (POST /api/mcp), to reject
 * cookie-authenticated callers — a cookie-authenticated call has no agent
 * label to attribute in the activity feed, so it must never reach an MCP
 * tool. Throws 401 (not 403): this mirrors requireAuth's "you're not
 * authenticated for this at all" semantics, rather than
 * requireSessionAuth's "you're authenticated, but via the wrong axis" 403.
 */
export async function requireAgentTokenAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (req.ctx?.authMethod !== "agent_token") {
    throw new UnauthorizedError();
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

/**
 * Layer 2 of the access model (must run after requireMembership). Loads the
 * `:projectId` route param scoped to the already-verified workspace and
 * enforces project-level visibility rules. Every denial path returns 404
 * (never 403) so an unauthorized caller cannot distinguish "this project
 * doesn't exist" from "it exists but you can't see it":
 *
 *  - CLIENT role: must have an explicit ProjectMembership row.
 *  - visibility "private": must have a ProjectMembership row, OR hold a
 *    role ranked >= PROJECT_MANAGER.
 *  - visibility "workspace": any active workspace member has access.
 *
 * Sets req.ctx.project and req.ctx.projectMembership (null if none).
 */
export async function requireProjectAccess(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.ctx?.user || !req.ctx?.workspace || !req.ctx?.membership) {
    throw new UnauthorizedError();
  }

  const params = req.params as Record<string, string | undefined>;
  const projectId = params.projectId;
  if (!projectId) {
    throw new NotFoundError(PROJECT_NOT_FOUND_MESSAGE);
  }

  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId: req.ctx.workspace.id },
  });
  if (!project) {
    throw new NotFoundError(PROJECT_NOT_FOUND_MESSAGE);
  }

  const roleKey = req.ctx.membership.role.key as RoleKey;

  const projectMembership = await prisma.projectMembership.findUnique({
    where: { projectId_userId: { projectId: project.id, userId: req.ctx.user.id } },
  });

  if (roleKey === "CLIENT") {
    if (!projectMembership) {
      throw new NotFoundError(PROJECT_NOT_FOUND_MESSAGE);
    }
  } else if (project.visibility === "private") {
    const hasElevatedRank = ROLE_RANK[roleKey] >= ROLE_RANK.PROJECT_MANAGER;
    if (!projectMembership && !hasElevatedRank) {
      throw new NotFoundError(PROJECT_NOT_FOUND_MESSAGE);
    }
  }
  // visibility === "workspace": any active workspace member has access.

  req.ctx.project = project;
  req.ctx.projectMembership = projectMembership;
}

/**
 * Layer 3 of the access model (must run after requireProjectAccess, before
 * any requirePermission(...) check for a category-scoped route). Loads the
 * `:categoryId` route param scoped to the already-verified
 * `req.ctx.project`, and enforces category-level visibility rules —
 * mirrors requireProjectAccess's exact shape, one level down. Every denial
 * path returns 404 (never 403), same non-leaking rationale as
 * requireProjectAccess:
 *
 *  - CLIENT role: always requires an explicit CategoryMembership row,
 *    regardless of the category's visibility — this mirrors CLIENT's
 *    existing "always requires ProjectMembership" rule for projects one
 *    level up, applied consistently one level down for categories.
 *  - visibility "private": must have a CategoryMembership row, OR hold a
 *    role ranked >= PROJECT_MANAGER (same threshold requireProjectAccess
 *    uses for private-project visibility).
 *  - visibility "workspace": any caller who already passed
 *    requireProjectAccess for this project has access.
 *
 * Sets req.ctx.category and req.ctx.categoryMembership (null if none). Live
 * DB check every request, never cached — matches every other guard here.
 */
export async function requireCategoryAccess(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.ctx?.user || !req.ctx?.membership || !req.ctx?.project) {
    throw new UnauthorizedError();
  }

  const params = req.params as Record<string, string | undefined>;
  const categoryId = params.categoryId;
  if (!categoryId) {
    throw new NotFoundError(CATEGORY_NOT_FOUND_MESSAGE);
  }

  const category = await prisma.taskCategory.findFirst({
    where: { id: categoryId, projectId: req.ctx.project.id },
  });
  if (!category) {
    throw new NotFoundError(CATEGORY_NOT_FOUND_MESSAGE);
  }

  const roleKey = req.ctx.membership.role.key as RoleKey;

  const categoryMembership = await prisma.categoryMembership.findUnique({
    where: { categoryId_userId: { categoryId: category.id, userId: req.ctx.user.id } },
  });

  if (roleKey === "CLIENT") {
    if (!categoryMembership) {
      throw new NotFoundError(CATEGORY_NOT_FOUND_MESSAGE);
    }
  } else if (category.visibility === "private") {
    const hasElevatedRank = ROLE_RANK[roleKey] >= ROLE_RANK.PROJECT_MANAGER;
    if (!categoryMembership && !hasElevatedRank) {
      throw new NotFoundError(CATEGORY_NOT_FOUND_MESSAGE);
    }
  }
  // visibility === "workspace": anyone who already has project access may proceed.

  req.ctx.category = category;
  req.ctx.categoryMembership = categoryMembership;
}

/**
 * Instance-wide platform-administrator gate. This is a DIFFERENT
 * authorization axis from everything else in this file: workspace RBAC
 * (requireMembership + requirePermission) answers "what may you do inside
 * workspace X", whereas User.isPlatformAdmin answers "do you administer
 * this ProjectHub installation". A workspace OWNER is NOT a platform
 * admin. Only the very first user, created via POST /api/setup, is.
 *
 * Unlike the workspace/project/category guards, denial is 403, not 404:
 * those return 404 so an outsider cannot probe whether a specific
 * workspace exists, but the existence of the platform-settings endpoints
 * is not a secret, so there is nothing to conceal. Mirrors
 * requirePermission's 403.
 *
 * Must run after requireAuth (it reads req.ctx.user).
 *
 * Platform administration is a DIFFERENT authorization axis from workspace
 * RBAC, deliberately not delegable to an AI client in v1: even a platform
 * admin's own agent token is rejected here, regardless of permissions.
 */
export async function requirePlatformAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.ctx?.user) {
    throw new UnauthorizedError();
  }
  if (req.ctx.authMethod !== "session") {
    throw new ForbiddenError();
  }
  if (!req.ctx.user.isPlatformAdmin) {
    throw new ForbiddenError();
  }
}

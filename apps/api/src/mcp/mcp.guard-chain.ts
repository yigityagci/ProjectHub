import type { FastifyReply, FastifyRequest } from "fastify";
import type { Permission } from "@projecthub/shared";
import { requireMembership, requireProjectAccess, requireCategoryAccess, requirePermission } from "../rbac/guards.js";

/**
 * Which access tier an MCP tool call operates at, carrying whichever of
 * workspaceId/projectId/categoryId are relevant — mirrors exactly the tiers
 * REST routes are nested under (see tasks.routes.ts's URL prefixes).
 */
export type ToolScope =
  | { tier: "user" }
  | { tier: "workspace"; workspaceId: string }
  | { tier: "project"; workspaceId: string; projectId: string }
  | { tier: "category"; workspaceId: string; projectId: string; categoryId: string };

/**
 * Emits ONLY the route params this tier actually needs — a mis-wired tool
 * (e.g. one that claims "category" tier but forgot to pass categoryId) must
 * 404 via requireCategoryAccess's own missing-param check, rather than
 * silently skipping that tier's access check.
 */
function buildParams(scope: ToolScope): Record<string, string> {
  switch (scope.tier) {
    case "user":
      return {};
    case "workspace":
      return { workspaceId: scope.workspaceId };
    case "project":
      return { workspaceId: scope.workspaceId, projectId: scope.projectId };
    case "category":
      return { workspaceId: scope.workspaceId, projectId: scope.projectId, categoryId: scope.categoryId };
  }
}

/**
 * Resets every scope-derived req.ctx slot before each tool call's guard
 * chain runs, preserving user/authMethod/sessionId/agentToken (which
 * requireAuth already set on this same request). A stateless MCP request
 * handles exactly one tool call, so this is defense in depth against any
 * accidental slot reuse, not a response to an observed leak.
 */
function resetScopeContext(req: FastifyRequest): void {
  req.ctx.workspace = undefined;
  req.ctx.membership = undefined;
  req.ctx.permissions = undefined;
  req.ctx.project = undefined;
  req.ctx.projectMembership = undefined;
  req.ctx.category = undefined;
  req.ctx.categoryMembership = undefined;
}

/**
 * Runs the REAL REST guard functions (requireMembership /
 * requireProjectAccess / requireCategoryAccess / requirePermission),
 * unmodified, in the same order the equivalent REST route would, against
 * the REAL Fastify request for this MCP tool call — never a fake request
 * object, never `app.inject()` re-entry. This is the single mechanism by
 * which an MCP tool call is authorized: there is no parallel authorization
 * system anywhere in this file.
 */
export async function runToolGuards(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: ToolScope,
  permission?: Permission,
): Promise<void> {
  resetScopeContext(req);
  req.params = buildParams(scope);

  if (scope.tier === "workspace" || scope.tier === "project" || scope.tier === "category") {
    await requireMembership(req, reply);
  }
  if (scope.tier === "project" || scope.tier === "category") {
    await requireProjectAccess(req, reply);
  }
  if (scope.tier === "category") {
    await requireCategoryAccess(req, reply);
  }
  if (permission) {
    await requirePermission(permission)(req, reply);
  }
}

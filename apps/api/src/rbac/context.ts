import type {
  CategoryMembership,
  Project,
  ProjectMembership,
  Role,
  RolePermission,
  TaskCategory,
  User,
  Workspace,
  WorkspaceMembership,
} from "@prisma/client";

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
}

/**
 * Which of the two bearer-credential shapes authenticated this request.
 * Populated exclusively by requireAuth, never anywhere else. `undefined`
 * means requireAuth didn't run (or matched neither path) — every gate that
 * checks this must treat `undefined` as "not agent-token-authenticated" /
 * "not session-authenticated" (fail closed), never as a third valid state.
 */
export type AuthMethod = "session" | "agent_token";

export interface RequestContext {
  user?: AuthenticatedUser;
  authMethod?: AuthMethod;
  /** Populated on the session path only (see requireAuth in rbac/guards.ts). */
  sessionId?: string;
  /** Populated on the agent_token path only (see requireAuth in rbac/guards.ts). */
  agentToken?: { id: string; label: string };
  workspace?: Workspace;
  membership?: WorkspaceMembership & { role: Role & { permissions: RolePermission[] } };
  permissions?: Set<string>;
  project?: Project;
  projectMembership?: ProjectMembership | null;
  category?: TaskCategory;
  categoryMembership?: CategoryMembership | null;
}

export function toAuthenticatedUser(user: User): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isPlatformAdmin: user.isPlatformAdmin,
  };
}

declare module "fastify" {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

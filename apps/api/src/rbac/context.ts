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

export interface RequestContext {
  user?: AuthenticatedUser;
  sessionId?: string;
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

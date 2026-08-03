import { PERMISSIONS, type Permission } from "./permissions.js";

/**
 * The six default, system-seeded workspace roles. These are created for
 * every new workspace at workspace-creation time (see workspaces.service).
 */
export const ROLE_KEYS = [
  "OWNER",
  "ADMIN",
  "PROJECT_MANAGER",
  "MEMBER",
  "VIEWER",
  "CLIENT",
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

export function isRoleKey(value: string): value is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(value);
}

/**
 * Rank ordering used for the "cannot assign a role higher than your own
 * rank" invariant. Higher number = more privileged. VIEWER and CLIENT are
 * both the lowest rank (read-only); CLIENT is additionally restricted to
 * assigned projects only, which is a Phase 2+ (project-membership) concern.
 */
export const ROLE_RANK: Record<RoleKey, number> = {
  OWNER: 5,
  ADMIN: 4,
  PROJECT_MANAGER: 3,
  MEMBER: 2,
  VIEWER: 1,
  CLIENT: 1,
};

export const ROLE_DISPLAY_NAME: Record<RoleKey, string> = {
  OWNER: "Workspace Owner",
  ADMIN: "Administrator",
  PROJECT_MANAGER: "Project Manager",
  MEMBER: "Member",
  VIEWER: "Viewer",
  CLIENT: "Client",
};

export const ROLE_DESCRIPTION: Record<RoleKey, string> = {
  OWNER:
    "Full control over workspace settings, members, and projects. Only owners can delete the workspace.",
  ADMIN:
    "Manages members, roles, and workspace settings. Can create and manage projects. Cannot delete workspace.",
  PROJECT_MANAGER:
    "Creates and manages projects and their tasks. Can assign work and track progress. Cannot change member roles.",
  MEMBER:
    "Completes assigned tasks and contributes to projects. Can create tasks and comment. Cannot create projects or manage members.",
  VIEWER: "Read-only access to all workspace content. Cannot create or edit anything.",
  CLIENT:
    "Read-only access to assigned projects and tasks only. Cannot access other workspace content.",
};

const ALL_PERMISSIONS: Permission[] = [...PERMISSIONS];

const ADMIN_PERMISSIONS: Permission[] = [
  "member.invite",
  "member.remove",
  "role.manage",
  "project.create",
  "project.edit",
  "project.delete",
  "project.archive",
  "project.members.manage",
  "board.manage",
  "task.create",
  "task.edit",
  "task.assign",
  "task.delete",
  "milestone.manage",
  "label.manage",
  "custom_field.manage",
  "dependency.manage",
  "analytics.view",
  "audit.view",
  "workspace.settings.manage",
  "category.manage",
  "registration_token.manage",
];

const PROJECT_MANAGER_PERMISSIONS: Permission[] = [
  "project.create",
  "project.edit",
  "project.archive",
  "project.members.manage",
  "board.manage",
  "task.create",
  "task.edit",
  "task.assign",
  "task.delete",
  "milestone.manage",
  "label.manage",
  "custom_field.manage",
  "dependency.manage",
  "analytics.view",
  "member.invite",
  "category.manage",
];

const MEMBER_PERMISSIONS: Permission[] = ["task.create", "task.edit", "task.assign"];

const VIEWER_PERMISSIONS: Permission[] = [];

const CLIENT_PERMISSIONS: Permission[] = [];

/**
 * Default role -> permission map applied when a workspace is created.
 * OWNER always has every known permission (including ones added in later
 * phases), everything else is an explicit allowlist.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  OWNER: ALL_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  PROJECT_MANAGER: PROJECT_MANAGER_PERMISSIONS,
  MEMBER: MEMBER_PERMISSIONS,
  VIEWER: VIEWER_PERMISSIONS,
  CLIENT: CLIENT_PERMISSIONS,
};

/**
 * Canonical permission catalog for ProjectHub.
 *
 * Permissions are plain strings so they can be stored directly in the
 * RolePermission table and compared without any decoding step. New
 * permissions added in later phases should be appended here, never
 * renamed (renaming would silently break existing RolePermission rows).
 */
export const PERMISSIONS = [
  // Workspace / membership management
  "workspace.settings.manage",
  "member.invite",
  "member.remove",
  "role.manage",
  "registration_token.manage",

  // Projects (Phase 2)
  "project.create",
  "project.edit",
  "project.delete",
  "project.archive",
  "project.members.manage",

  // Kanban boards / tasks (Phase 2)
  "board.manage",
  "task.create",
  "task.edit",
  "task.assign",
  "task.delete",
  "milestone.manage",
  "label.manage",
  "dependency.manage",

  // Observability
  "analytics.view",
  "audit.view",

  // Categories (Project -> Category -> Task isolation tier)
  "category.manage",

  // Custom fields on tasks (project-scoped typed field definitions)
  "custom_field.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

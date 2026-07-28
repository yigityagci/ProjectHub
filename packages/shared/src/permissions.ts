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

  // Projects (schema/routes land in Phase 2; permission strings are
  // reserved now so the RBAC catalog and default role map are stable)
  "project.create",
  "project.edit",
  "project.delete",

  // Tasks (Phase 2)
  "task.assign",
  "task.delete",

  // Observability
  "analytics.view",
  "audit.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

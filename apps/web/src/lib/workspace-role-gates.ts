/**
 * Workspace-level role gates shared across three Settings-adjacent
 * consumers (SettingsPage.tsx's nav visibility + unknown-tab redirect,
 * ManageTeamTab.tsx's per-panel gating, and ProjectsPage.tsx's "Manage
 * team" link gate). This codebase's usual convention is per-page
 * duplication of these gate constants (see e.g. ProjectSettingsPage.tsx,
 * CategoriesPage.tsx) — this file is a deliberate exception, approved
 * because three consumers of the identical 4-way OR below would otherwise
 * drift out of sync as roles/permissions evolve.
 *
 * Every constant here is a UX affordance only — the real security boundary
 * is always the corresponding server-side `requirePermission(...)` guard
 * chain (see apps/api/src/rbac/guards.ts and packages/shared/src/roles.ts's
 * DEFAULT_ROLE_PERMISSIONS). A role change taking effect client-side
 * requires nothing beyond a page refresh; the server re-checks every time.
 */

// Mirrors `member.invite`'s grant in DEFAULT_ROLE_PERMISSIONS.
export const CAN_INVITE_ROLES = new Set(["OWNER", "ADMIN", "PROJECT_MANAGER"]);

// Mirrors `role.manage`'s grant.
export const CAN_MANAGE_ROLES_ROLES = new Set(["OWNER", "ADMIN"]);

// Mirrors `member.remove`'s grant.
export const CAN_REMOVE_MEMBER_ROLES = new Set(["OWNER", "ADMIN"]);

// Mirrors `workspace.settings.manage`'s grant (OWNER/ADMIN only —
// PROJECT_MANAGER does not have it).
export const CAN_MANAGE_WORKSPACE_SETTINGS_ROLES = new Set(["OWNER", "ADMIN"]);

/**
 * Union of the four gates above — whether the caller should see the Manage
 * Team tab/link at all (an invite-only PROJECT_MANAGER still needs to reach
 * it even though none of the other three permissions apply to them). Each
 * individual panel inside ManageTeamTab still re-checks its own specific
 * gate from the four constants above.
 */
export function canAccessManageTeam(role: string | null): boolean {
  return (
    role !== null &&
    (CAN_INVITE_ROLES.has(role) ||
      CAN_MANAGE_ROLES_ROLES.has(role) ||
      CAN_REMOVE_MEMBER_ROLES.has(role) ||
      CAN_MANAGE_WORKSPACE_SETTINGS_ROLES.has(role))
  );
}

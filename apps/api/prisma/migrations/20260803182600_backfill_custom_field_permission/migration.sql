-- Backfill: DEFAULT_ROLE_PERMISSIONS in packages/shared/src/roles.ts is only
-- consulted when a workspace's Role/RolePermission rows are first seeded, at
-- workspace-creation time (see workspaces.service.ts) — it is never read live
-- at request time (requireMembership loads permissions from the
-- role_permissions table). Adding "custom_field.manage" to that constant
-- therefore has zero effect on any workspace created before this migration;
-- every existing OWNER/ADMIN/PROJECT_MANAGER role is missing the row entirely
-- and would 403 on every custom-field-definition endpoint. This backfills it
-- for every existing workspace, exactly mirroring how label.manage is granted.
INSERT INTO "role_permissions" ("id", "roleId", "permission")
SELECT gen_random_uuid(), r."id", 'custom_field.manage'
FROM "roles" r
WHERE r."key" IN ('OWNER', 'ADMIN', 'PROJECT_MANAGER')
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp
    WHERE rp."roleId" = r."id" AND rp."permission" = 'custom_field.manage'
  );

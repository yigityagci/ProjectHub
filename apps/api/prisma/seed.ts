/**
 * Prisma seed script.
 *
 * IMPORTANT: this script intentionally does NOT create any User or
 * Workspace. Default Roles + RolePermission rows are created
 * transactionally in application code at workspace-creation time (see
 * src/workspaces/workspaces.service.ts), not here. There is no seeded
 * user, no default credentials, and no hard-coded workspace anywhere in
 * this codebase — the only way to create the first user is the
 * `/api/setup` bootstrap flow, which only works while zero users exist.
 *
 * This file exists solely to document/print the static permission
 * catalog and default role -> permission map for reference.
 */
import { PERMISSIONS, ROLE_KEYS, DEFAULT_ROLE_PERMISSIONS } from "@projecthub/shared";

function main() {
  // eslint-disable-next-line no-console
  console.log("ProjectHub permission catalog:");
  // eslint-disable-next-line no-console
  console.log(PERMISSIONS);
  // eslint-disable-next-line no-console
  console.log("\nDefault role -> permission map:");
  for (const roleKey of ROLE_KEYS) {
    // eslint-disable-next-line no-console
    console.log(`  ${roleKey}:`, DEFAULT_ROLE_PERMISSIONS[roleKey]);
  }
}

main();

import type { CurrentUser } from "../../App.js";
import type { UserSettings } from "../../lib/user-settings.js";

export type { UserSettings };

/**
 * Uniform prop contract for every Settings tab. `onLoggedOut` is only
 * consumed by SessionsTab (revoking your own current session must behave
 * like a manual logout), but it's kept in the shared contract rather than a
 * one-off prop so every tab component has an identical signature.
 */
export interface SettingsTabProps {
  user: CurrentUser;
  // null on the workspace-agnostic /settings/:tab routes (Personalization,
  // ProjectHub Administration, and every other non-workspace-scoped tab).
  // Only ManageTeamTab actually dereferences this, and it's only ever
  // rendered when a real workspaceId exists (see tabs.ts's
  // requiresManageTeam gate), so no other tab needs to narrow this itself.
  workspaceId: string | null;
  // Already fetched once by the SettingsPage shell (which also owns the
  // breadcrumb/topbar rendering it) — ManageTeamTab reuses these instead of
  // re-fetching GET /api/workspaces/:workspaceId itself.
  workspaceName: string;
  onWorkspaceRenamed: (name: string) => void;
  role: string | null;
  settings: UserSettings;
  onSettingsChange: (next: UserSettings) => void;
  onUserUpdated: (u: CurrentUser) => void;
  onLoggedOut: () => void;
}

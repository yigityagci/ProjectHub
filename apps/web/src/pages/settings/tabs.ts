import type { ComponentType } from "react";
import ProfileTab from "./ProfileTab.js";
import AccountTab from "./AccountTab.js";
import NotificationsTab from "./NotificationsTab.js";
import AppearanceTab from "./AppearanceTab.js";
import LanguageRegionTab from "./LanguageRegionTab.js";
import SecurityTab from "./SecurityTab.js";
import SessionsTab from "./SessionsTab.js";
import AgentTokensTab from "./AgentTokensTab.js";
import AccessibilityTab from "./AccessibilityTab.js";
import PersonalizationTab from "./PersonalizationTab.js";
import ManageTeamTab from "./ManageTeamTab.js";
import ProjectHubAdminTab from "./ProjectHubAdminTab.js";
import type { SettingsTabProps } from "./types.js";

// Dividing rule (see also ProjectHubAdminTab.tsx's own header comment):
// only config with NO workspaceId, gated by requirePlatformAdmin, belongs
// in "ProjectHub Administration" — workspace-scoped config like
// registration tokens stays on Manage Team.
export interface SettingsTabDefinition {
  slug: string;
  label: string;
  component: ComponentType<SettingsTabProps>;
  // Gated on canAccessManageTeam(role) — see lib/workspace-role-gates.ts.
  // Workspace RBAC, not platform-wide.
  requiresManageTeam?: boolean;
  // Gated directly on user.isPlatformAdmin in SettingsPage.tsx — a
  // different authorization axis entirely from workspace RBAC (a platform-
  // wide admin flag, not a workspace role), so it deliberately does not
  // route through lib/workspace-role-gates.ts.
  requiresPlatformAdmin?: boolean;
}

// Tab order matches the design handoff: "manage-team" is only rendered/
// linked when the caller passes canAccessManageTeam(role), and
// "projecthub-admin" only when user.isPlatformAdmin — both filtered by
// SettingsPage.tsx, never reordered here. "projecthub-admin" is last;
// "manage-team" is second-to-last.
export const SETTINGS_TABS: SettingsTabDefinition[] = [
  { slug: "profile", label: "Profile", component: ProfileTab },
  { slug: "account", label: "Account", component: AccountTab },
  { slug: "notifications", label: "Notifications", component: NotificationsTab },
  { slug: "appearance", label: "Appearance", component: AppearanceTab },
  { slug: "language", label: "Language & Region", component: LanguageRegionTab },
  { slug: "security", label: "Security", component: SecurityTab },
  { slug: "sessions", label: "Sessions", component: SessionsTab },
  { slug: "agent-tokens", label: "AI Agent Tokens", component: AgentTokensTab },
  { slug: "accessibility", label: "Accessibility", component: AccessibilityTab },
  { slug: "personalization", label: "Personalization", component: PersonalizationTab },
  { slug: "manage-team", label: "Manage Team", component: ManageTeamTab, requiresManageTeam: true },
  {
    slug: "projecthub-admin",
    label: "ProjectHub Administration",
    component: ProjectHubAdminTab,
    requiresPlatformAdmin: true,
  },
];

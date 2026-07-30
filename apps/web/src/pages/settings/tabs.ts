import type { ComponentType } from "react";
import ProfileTab from "./ProfileTab.js";
import AccountTab from "./AccountTab.js";
import NotificationsTab from "./NotificationsTab.js";
import AppearanceTab from "./AppearanceTab.js";
import LanguageRegionTab from "./LanguageRegionTab.js";
import SecurityTab from "./SecurityTab.js";
import SessionsTab from "./SessionsTab.js";
import AccessibilityTab from "./AccessibilityTab.js";
import ManageTeamTab from "./ManageTeamTab.js";
import type { SettingsTabProps } from "./types.js";

export interface SettingsTabDefinition {
  slug: string;
  label: string;
  component: ComponentType<SettingsTabProps>;
  // Gated on canAccessManageTeam(role) — see lib/workspace-role-gates.ts.
  requiresManageTeam?: boolean;
}

// Tab order matches the design handoff exactly; "manage-team" is always
// last and only rendered/linked when the caller passes
// canAccessManageTeam(role).
export const SETTINGS_TABS: SettingsTabDefinition[] = [
  { slug: "profile", label: "Profile", component: ProfileTab },
  { slug: "account", label: "Account", component: AccountTab },
  { slug: "notifications", label: "Notifications", component: NotificationsTab },
  { slug: "appearance", label: "Appearance", component: AppearanceTab },
  { slug: "language", label: "Language & Region", component: LanguageRegionTab },
  { slug: "security", label: "Security", component: SecurityTab },
  { slug: "sessions", label: "Sessions", component: SessionsTab },
  { slug: "accessibility", label: "Accessibility", component: AccessibilityTab },
  { slug: "manage-team", label: "Manage Team", component: ManageTeamTab, requiresManageTeam: true },
];

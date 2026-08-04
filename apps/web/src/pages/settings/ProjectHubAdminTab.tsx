import MailDeliveryPanel from "./MailDeliveryPanel.js";
import type { SettingsTabProps } from "./types.js";

// Dividing rule between this tab and Manage Team's Registration Tokens
// panel: only config with NO workspaceId, gated by requirePlatformAdmin,
// belongs here. Workspace-scoped config (registration tokens require both
// a workspaceId and a workspace-scoped roleId) stays on Manage Team — see
// tabs.ts's header comment for the full rationale.
//
// Structured as a card-stack (mirrors ManageTeamTab -> RegistrationTokensPanel's
// tab/panel split) so future platform-wide surfaces can be added as sibling
// panels below Mail Delivery without restructuring this tab.
export default function ProjectHubAdminTab({ user }: SettingsTabProps) {
  return (
    <>
      <div className="ph-card ph-card-wide" style={{ marginBottom: "1.5rem" }}>
        <h2 style={{ margin: "0 0 0.35rem", fontSize: "1.05rem" }}>ProjectHub Administration</h2>
        <p className="ph-subtitle" style={{ margin: 0 }}>
          Platform-wide configuration. These settings affect every workspace on this instance.
        </p>
      </div>

      <MailDeliveryPanel userEmail={user.email} />
    </>
  );
}

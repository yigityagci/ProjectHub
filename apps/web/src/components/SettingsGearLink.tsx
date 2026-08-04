import { Link, useParams } from "react-router-dom";
import { IconGear } from "./Icons.js";

/**
 * Shared "go to Settings" gear icon dropped into `.ph-topbar-actions` right
 * after `{user.displayName}` on every page that renders a topbar — a single
 * component rather than duplicating the same Link/icon markup 8 times.
 * Resolves its own link target from the current route's `:workspaceId`
 * param (absent on workspace-agnostic pages), mirroring how SettingsPage
 * itself computes `settingsBase`.
 */
export default function SettingsGearLink() {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const base = workspaceId ? `/workspace/${workspaceId}/settings` : "/settings";
  return (
    <Link
      to={`${base}/profile`}
      className="ph-icon-only-btn"
      aria-label="Settings"
      title="Settings"
      style={{ textDecoration: "none" }}
    >
      <IconGear size={18} />
    </Link>
  );
}

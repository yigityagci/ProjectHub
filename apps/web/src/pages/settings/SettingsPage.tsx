import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { Brand } from "../../App.js";
import type { CurrentUser } from "../../App.js";
import { api, ApiError } from "../../lib/api.js";
import NotificationBell from "../../components/NotificationBell.js";
import ThemeToggle from "../../components/ThemeToggle.js";
import { canAccessManageTeam } from "../../lib/workspace-role-gates.js";
import { applyPreferencesFromServer } from "../../lib/a11y.js";
import { SETTINGS_TABS } from "./tabs.js";
import type { UserSettings } from "./types.js";

interface SettingsPageProps {
  user: CurrentUser;
  onUserUpdated: (u: CurrentUser) => void;
  onLoggedOut: () => void;
}

export default function SettingsPage({ user, onUserUpdated, onLoggedOut }: SettingsPageProps) {
  const { workspaceId, tab } = useParams<{ workspaceId: string; tab?: string }>();
  const navigate = useNavigate();

  const [workspaceName, setWorkspaceName] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);

  const [settings, setSettings] = useState<UserSettings | null>(null);

  async function loadWorkspace() {
    if (!workspaceId) return;
    try {
      const ws = await api.get<{ workspace: { name: string }; role: string }>(
        `/api/workspaces/${workspaceId}`,
      );
      setWorkspaceName(ws.workspace.name);
      setRole(ws.role);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        navigate("/");
        return;
      }
    } finally {
      setWorkspaceLoaded(true);
    }
  }

  async function loadSettings() {
    try {
      const res = await api.get<{ user: UserSettings }>("/api/auth/me");
      setSettings(res.user);
      applyPreferencesFromServer(res.user);
    } catch {
      // A 401 here means the session died between App.tsx's own check and
      // this fetch; the route guard elsewhere will bounce to /login on the
      // next navigation. Nothing extra to do from inside this page.
    }
  }

  useEffect(() => {
    loadWorkspace().catch(() => undefined);
    loadSettings().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const canManageTeam = canAccessManageTeam(role);
  const isKnownTab = Boolean(tab) && SETTINGS_TABS.some((t) => t.slug === tab);

  if (!isKnownTab) {
    return <Navigate to={`/workspace/${workspaceId}/settings/profile`} replace />;
  }
  // Only redirect off manage-team once role has actually resolved — role
  // starts null on first render, and bouncing a permitted user before their
  // role loads would be a false negative.
  if (tab === "manage-team" && workspaceLoaded && !canManageTeam) {
    return <Navigate to={`/workspace/${workspaceId}/settings/profile`} replace />;
  }

  const activeTab = SETTINGS_TABS.find((t) => t.slug === tab);
  const TabComponent = activeTab?.component;
  const ready = workspaceLoaded && settings !== null && workspaceId !== undefined;

  return (
    <div className="ph-shell ph-shell-wide">
      <div className="ph-topbar ph-topbar-wide">
        <Brand />
        <div className="ph-topbar-actions">
          <ThemeToggle />
          <NotificationBell />
          <span style={{ fontSize: "0.9rem" }}>{user.displayName}</span>
        </div>
      </div>

      <div className="ph-page-wide">
        <div className="ph-breadcrumb">
          <Link to="/">Your workspaces</Link> /{" "}
          <Link to={`/workspace/${workspaceId}/projects`}>{workspaceName || "..."}</Link> / Settings
        </div>

        <div className="ph-page-header">
          <div>
            <h1>Settings</h1>
          </div>
        </div>

        <div className="ph-subnav flex-wrap">
          {SETTINGS_TABS.filter((t) => !t.requiresManageTeam || canManageTeam).map((t) => (
            <Link
              key={t.slug}
              className={`ph-subnav-link whitespace-nowrap${tab === t.slug ? " ph-subnav-active" : ""}`}
              to={`/workspace/${workspaceId}/settings/${t.slug}`}
            >
              {t.label}
            </Link>
          ))}
        </div>

        {!ready ? (
          <p>Loading...</p>
        ) : TabComponent && settings ? (
          <TabComponent
            user={user}
            workspaceId={workspaceId!}
            workspaceName={workspaceName}
            onWorkspaceRenamed={(name) => setWorkspaceName(name)}
            role={role}
            settings={settings}
            onSettingsChange={setSettings}
            onUserUpdated={onUserUpdated}
            onLoggedOut={onLoggedOut}
          />
        ) : null}
      </div>
    </div>
  );
}

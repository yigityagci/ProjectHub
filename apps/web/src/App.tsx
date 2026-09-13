import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./lib/api.js";
import { getSocket, disconnectSocket } from "./lib/socket.js";
import { applyPreferencesFromServer } from "./lib/a11y.js";
import { applyPersonalizationFromServer, resolveLandingPath } from "./lib/personalization.js";
import type { UserSettings } from "./lib/user-settings.js";
import SetupPage from "./pages/SetupPage.js";
import LoginPage from "./pages/LoginPage.js";
import RegisterPage from "./pages/RegisterPage.js";
import WorkspacesPage from "./pages/WorkspacesPage.js";
import InviteAcceptPage from "./pages/InviteAcceptPage.js";
import ForgotPasswordPage from "./pages/ForgotPasswordPage.js";
import ResetPasswordPage from "./pages/ResetPasswordPage.js";
import ProjectsPage from "./pages/ProjectsPage.js";
import CategoriesPage from "./pages/CategoriesPage.js";
import NewCategoryPage from "./pages/NewCategoryPage.js";
import KanbanBoardPage from "./pages/KanbanBoardPage.js";
import AnalyticsPage from "./pages/AnalyticsPage.js";
import ProjectSettingsPage from "./pages/ProjectSettingsPage.js";
import SettingsPage from "./pages/settings/SettingsPage.js";

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
  isPlatformAdmin: boolean;
}

export function Brand() {
  return <div className="ph-brand">ProjectHub</div>;
}

export default function App() {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const status = await api.get<{ needsSetup: boolean }>("/api/setup/status");
        setNeedsSetup(status.needsSetup);
        if (!status.needsSetup) {
          try {
            const me = await api.get<{ user: UserSettings }>("/api/auth/me");
            setUser({
              id: me.user.id,
              email: me.user.email,
              displayName: me.user.displayName,
              avatarUrl: me.user.avatarUrl,
              isPlatformAdmin: me.user.isPlatformAdmin,
            });
            // DB is the cross-device source of truth; mirror it down into
            // localStorage right away so it's applied on the very next
            // pre-paint load (see apps/web/src/lib/a11y.ts).
            applyPreferencesFromServer(me.user);
            applyPersonalizationFromServer(me.user);
          } catch {
            setUser(null);
          }
        }
      } finally {
        setChecked(true);
      }
    })();
  }, []);

  // Connects the shared Socket.IO client once a user session exists (it
  // authenticates via the same `ph_session` cookie as REST) and tears it
  // down on logout. Individual pages join the workspace/project rooms they
  // need on top of this base connection.
  useEffect(() => {
    if (user) {
      getSocket();
    } else {
      disconnectSocket();
    }
  }, [user]);

  if (!checked) {
    return (
      <div className="ph-shell">
        <Brand />
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/setup"
        element={
          needsSetup ? (
            <SetupPage
              onComplete={(u) => {
                setNeedsSetup(false);
                setUser(u);
              }}
            />
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route
        path="/login"
        element={
          needsSetup ? (
            <Navigate to="/setup" replace />
          ) : user ? (
            // Post-login (and any other fresh-authenticated hit on
            // /login) lands on the user's chosen default landing page
            // rather than unconditionally the workspaces list — see
            // resolveLandingPath() in lib/personalization.ts.
            <Navigate to={resolveLandingPath()} replace />
          ) : (
            <LoginPage onLoggedIn={(u) => setUser(u)} />
          )
        }
      />
      <Route
        path="/register"
        element={
          needsSetup ? (
            <Navigate to="/setup" replace />
          ) : user ? (
            <Navigate to="/" replace />
          ) : (
            <RegisterPage />
          )
        }
      />
      <Route path="/invite/accept" element={<InviteAcceptPage user={user} />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        path="/platform-settings/email"
        element={user ? <Navigate to="/settings/projecthub-admin" replace /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/workspace/:workspaceId/projects"
        element={user ? <ProjectsPage user={user} /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/settings"
        element={
          user ? (
            <SettingsPage user={user} onUserUpdated={(u) => setUser(u)} onLoggedOut={() => setUser(null)} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/settings/:tab"
        element={
          user ? (
            <SettingsPage user={user} onUserUpdated={(u) => setUser(u)} onLoggedOut={() => setUser(null)} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/workspace/:workspaceId/settings"
        element={
          user ? (
            <SettingsPage user={user} onUserUpdated={(u) => setUser(u)} onLoggedOut={() => setUser(null)} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/workspace/:workspaceId/settings/:tab"
        element={
          user ? (
            <SettingsPage user={user} onUserUpdated={(u) => setUser(u)} onLoggedOut={() => setUser(null)} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/workspace/:workspaceId/projects/:projectId/categories"
        element={user ? <CategoriesPage user={user} /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/workspace/:workspaceId/projects/:projectId/settings"
        element={user ? <ProjectSettingsPage user={user} /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/workspace/:workspaceId/projects/:projectId/categories/new"
        element={user ? <NewCategoryPage user={user} /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/workspace/:workspaceId/projects/:projectId/categories/:categoryId/board"
        element={user ? <KanbanBoardPage user={user} /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/workspace/:workspaceId/projects/:projectId/analytics"
        element={user ? <AnalyticsPage user={user} /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/"
        element={
          needsSetup ? (
            <Navigate to="/setup" replace />
          ) : user ? (
            <LandingRedirect user={user} onLogout={() => setUser(null)} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
    </Routes>
  );
}

interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
}

/**
 * Wraps WorkspacesPage at "/" with two shortcuts that skip the workspace
 * picker entirely for the common case:
 *
 * 1. A one-time, fresh-page-load-only redirect to the user's chosen default
 *    landing page (Personalization tab -> "Default landing page after
 *    login", see lib/personalization.ts). `location.key === "default"` is
 *    react-router v6's own marker for the very first location of a browser
 *    tab's history — i.e. a real fresh load/direct navigation, never an
 *    in-app Link click or programmatic navigate (both always mint a fresh
 *    random key). This is pure derived render data (no external mutation),
 *    so it's also safe under React 18 StrictMode's double-render — unlike a
 *    sessionStorage-flag-during-render approach, there's no write to react to.
 * 2. Every self-hosted instance now auto-creates exactly one workspace at
 *    setup time (see apps/api/src/auth/setup.routes.ts), so a user with
 *    exactly one workspace membership never needs to pick one — redirect
 *    straight into it. WorkspacesPage itself is unchanged and stays reachable
 *    as a fallback for the 0-workspace (pre-existing admin who never made
 *    one) and >1-workspace (pre-existing multi-workspace install) cases.
 *
 *    Deliberately NOT gated on the "Default landing page" personalization
 *    preference being "workspaces": that value is every user's untouched
 *    DB default (`User.defaultLandingPage @default("workspaces")`), not a
 *    considered opt-in — gating on it would silently defeat this redirect
 *    for every fresh single-workspace install (the common case this exists
 *    for) rather than just the rare user who deliberately re-selected
 *    "Your workspaces list" after trying "projects". There's no stored
 *    signal that distinguishes "never touched" from "deliberately chosen"
 *    for this preference, so shortcut 2 intentionally takes priority.
 */
function LandingRedirect({ user, onLogout }: { user: CurrentUser; onLogout: () => void }) {
  const location = useLocation();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);

  useEffect(() => {
    api
      .get<{ workspaces: WorkspaceSummary[] }>("/api/workspaces")
      .then((res) => setWorkspaces(res.workspaces))
      .catch(() => setWorkspaces([]));
  }, []);

  if (location.key === "default") {
    const target = resolveLandingPath();
    if (target !== "/") return <Navigate to={target} replace />;
  }

  if (workspaces === null) {
    return (
      <div className="ph-shell">
        <Brand />
      </div>
    );
  }

  if (workspaces.length === 1) {
    return <Navigate to={`/workspace/${workspaces[0]!.id}/projects`} replace />;
  }

  return <WorkspacesPage user={user} onLogout={onLogout} />;
}

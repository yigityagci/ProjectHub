import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api } from "./lib/api.js";
import { getSocket, disconnectSocket } from "./lib/socket.js";
import { applyPreferencesFromServer } from "./lib/a11y.js";
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
}

export function Brand() {
  return (
    <div className="ph-brand">
      <span className="ph-logo">P</span>
      ProjectHub
    </div>
  );
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
            });
            // DB is the cross-device source of truth; mirror it down into
            // localStorage right away so it's applied on the very next
            // pre-paint load (see apps/web/src/lib/a11y.ts).
            applyPreferencesFromServer(me.user);
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
          user ? (
            <Navigate to="/" replace />
          ) : (
            <LoginPage onLoggedIn={(u) => setUser(u)} />
          )
        }
      />
      <Route
        path="/register"
        element={user ? <Navigate to="/" replace /> : <RegisterPage />}
      />
      <Route path="/invite/accept" element={<InviteAcceptPage user={user} />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        path="/workspace/:workspaceId/projects"
        element={user ? <ProjectsPage user={user} /> : <Navigate to="/login" replace />}
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
            <WorkspacesPage user={user} onLogout={() => setUser(null)} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
    </Routes>
  );
}

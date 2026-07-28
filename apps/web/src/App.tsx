import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api } from "./lib/api.js";
import SetupPage from "./pages/SetupPage.js";
import LoginPage from "./pages/LoginPage.js";
import WorkspacesPage from "./pages/WorkspacesPage.js";
import InviteAcceptPage from "./pages/InviteAcceptPage.js";

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
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
            const me = await api.get<{ user: CurrentUser }>("/api/auth/me");
            setUser(me.user);
          } catch {
            setUser(null);
          }
        }
      } finally {
        setChecked(true);
      }
    })();
  }, []);

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
            <SetupPage onComplete={(u) => setUser(u)} />
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
      <Route path="/invite/accept" element={<InviteAcceptPage user={user} />} />
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

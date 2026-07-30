import { useState, type FormEvent } from "react";
import { PASSWORD_POLICY_MESSAGE } from "@projecthub/shared";
import { api, ApiError } from "../../lib/api.js";
import type { SettingsTabProps } from "./types.js";

export default function SecurityTab(_props: SettingsTabProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (newPassword !== confirmPassword) {
      setError("New passwords do not match.");
      return;
    }

    setSaving(true);
    try {
      // This endpoint deliberately never triggers the frontend
      // logout-redirect behavior (that's the Sessions tab's self-revoke
      // case only) — the caller's own current session stays active
      // server-side, so the user explicitly remains on this page.
      await api.post("/api/auth/password/change", { currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess("Password changed");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ph-card ph-card-wide">
      <h1 style={{ fontSize: "1rem" }}>Security</h1>
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        Change your password.
      </p>
      <div className="ph-alert ph-alert-warning">
        Changing your password will sign you out of all other active sessions and devices. Your current
        session will remain active.
      </div>
      {error && <div className="ph-alert ph-alert-error">{error}</div>}
      {success && <div className="ph-alert ph-alert-success">{success}</div>}
      <form onSubmit={handleSubmit}>
        <div className="ph-field">
          <label htmlFor="securityCurrentPassword">Current password</label>
          <input
            id="securityCurrentPassword"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </div>
        <div className="ph-field">
          <label htmlFor="securityNewPassword">New password</label>
          <input
            id="securityNewPassword"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
          <p className="ph-subtitle" style={{ margin: "0.35rem 0 0" }}>
            {PASSWORD_POLICY_MESSAGE}
          </p>
        </div>
        <div className="ph-field">
          <label htmlFor="securityConfirmPassword">Confirm new password</label>
          <input
            id="securityConfirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
        </div>
        <button
          className="ph-button"
          type="submit"
          disabled={saving || !currentPassword || !newPassword || !confirmPassword}
          style={{ width: "auto" }}
        >
          {saving ? "Changing password..." : "Change password"}
        </button>
      </form>
    </div>
  );
}

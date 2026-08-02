import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../lib/api.js";
import type { SettingsTabProps } from "./types.js";

export default function AccountTab({ settings, onSettingsChange, onUserUpdated }: SettingsTabProps) {
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const res = await api.post<{ user: typeof settings }>("/api/auth/email/change", {
        newEmail: newEmail.trim(),
        currentPassword,
      });
      onSettingsChange(res.user);
      onUserUpdated({
        id: res.user.id,
        email: res.user.email,
        displayName: res.user.displayName,
        avatarUrl: res.user.avatarUrl,
        isPlatformAdmin: res.user.isPlatformAdmin,
      });
      setNewEmail("");
      setCurrentPassword("");
      setSuccess("Email updated");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ph-card ph-card-wide">
      <h1 style={{ fontSize: "1rem" }}>Account</h1>
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        Manage your email address.
      </p>
      {error && <div className="ph-alert ph-alert-error">{error}</div>}
      {success && (
        <div className="ph-alert ph-alert-success">
          {success}
          <div style={{ marginTop: "0.35rem", fontWeight: 400 }}>
            Email changes are applied immediately without verification.
          </div>
        </div>
      )}
      <div className="ph-field">
        <label htmlFor="settingsCurrentEmail">Current email</label>
        <input id="settingsCurrentEmail" value={settings.email} disabled readOnly />
      </div>
      <form onSubmit={handleSubmit}>
        <div className="ph-field">
          <label htmlFor="settingsNewEmail">New email</label>
          <input
            id="settingsNewEmail"
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            required
          />
        </div>
        <div className="ph-field">
          <label htmlFor="settingsEmailCurrentPassword">Current password</label>
          <input
            id="settingsEmailCurrentPassword"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </div>
        <button className="ph-button" type="submit" disabled={saving || !newEmail.trim() || !currentPassword}>
          {saving ? "Saving..." : "Update email"}
        </button>
      </form>
    </div>
  );
}

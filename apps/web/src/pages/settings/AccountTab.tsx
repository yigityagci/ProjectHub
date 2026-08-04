import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api.js";
import type { SettingsTabProps } from "./types.js";

export default function AccountTab({ settings, onSettingsChange, onUserUpdated, onLoggedOut }: SettingsTabProps) {
  const navigate = useNavigate();
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  async function handleDeleteAccount(e: FormEvent) {
    e.preventDefault();
    setDeleteError(null);
    setDeleting(true);
    try {
      await api.post("/api/auth/account/delete", { currentPassword: deletePassword });
      // The server already revoked this session and cleared the session
      // cookie — no separate client-side logout call is needed, mirrors
      // SessionsTab's own-session-revocation handling exactly.
      onLoggedOut();
      navigate("/login");
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Something went wrong.");
      setDeleting(false);
    }
  }

  return (
    <>
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

    <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
      <h1 style={{ fontSize: "1rem" }}>Danger Zone</h1>
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        Deleting your account is permanent. You will be logged out immediately and will not be able to log
        back in. Your name will remain visible on your past comments, activity, and task assignments,
        labeled &quot;(deleted account)&quot;. Your projects, tasks, and comments are NOT deleted. Your email
        address becomes available for a new signup.
      </p>
      {deleteError && <div className="ph-alert ph-alert-error">{deleteError}</div>}
      {confirmingDelete ? (
        <form onSubmit={handleDeleteAccount}>
          <div className="ph-field">
            <label htmlFor="settingsDeleteAccountPassword">Current password</label>
            <input
              id="settingsDeleteAccountPassword"
              type="password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              required
            />
          </div>
          <div style={{ display: "flex", gap: "0.6rem" }}>
            <button
              type="submit"
              className="ph-remove-btn"
              style={{ border: "1px solid var(--ph-error)" }}
              disabled={deleting || !deletePassword}
            >
              {deleting ? "Deleting..." : "Yes, permanently delete my account"}
            </button>
            <button
              type="button"
              className="ph-button ph-button-secondary"
              style={{ width: "auto" }}
              onClick={() => {
                setConfirmingDelete(false);
                setDeletePassword("");
                setDeleteError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="ph-remove-btn"
          style={{ border: "1px solid var(--ph-error)" }}
          onClick={() => setConfirmingDelete(true)}
        >
          Delete my account
        </button>
      )}
    </div>
    </>
  );
}

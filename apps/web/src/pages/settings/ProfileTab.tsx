import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../lib/api.js";
import type { SettingsTabProps } from "./types.js";

export default function ProfileTab({ settings, onSettingsChange, onUserUpdated }: SettingsTabProps) {
  const [displayName, setDisplayName] = useState(settings.displayName);
  const [avatarUrl, setAvatarUrl] = useState(settings.avatarUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const dirty =
    displayName.trim() !== settings.displayName || avatarUrl.trim() !== (settings.avatarUrl ?? "");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const res = await api.patch<{ user: typeof settings }>("/api/auth/me/profile", {
        displayName: displayName.trim(),
        avatarUrl: avatarUrl.trim() ? avatarUrl.trim() : null,
      });
      onSettingsChange(res.user);
      onUserUpdated({
        id: res.user.id,
        email: res.user.email,
        displayName: res.user.displayName,
        avatarUrl: res.user.avatarUrl,
      });
      setDisplayName(res.user.displayName);
      setAvatarUrl(res.user.avatarUrl ?? "");
      setSuccess("Profile updated");
    } catch (err) {
      // Form state is preserved on failure — never cleared.
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ph-card ph-card-wide">
      <h1 style={{ fontSize: "1rem" }}>Profile</h1>
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        Update your display name and avatar.
      </p>
      {error && <div className="ph-alert ph-alert-error">{error}</div>}
      {success && <div className="ph-alert ph-alert-success">{success}</div>}
      <form onSubmit={handleSubmit}>
        <div className="ph-field">
          <label htmlFor="settingsDisplayName">Display name</label>
          <input
            id="settingsDisplayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
        </div>
        <div className="ph-field">
          <label htmlFor="settingsAvatarUrl">Avatar URL</label>
          <input
            id="settingsAvatarUrl"
            type="url"
            placeholder="https://example.com/avatar.png"
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
          />
        </div>
        <button className="ph-button" type="submit" disabled={saving || !dirty || !displayName.trim()}>
          {saving ? "Saving..." : "Save"}
        </button>
      </form>
    </div>
  );
}

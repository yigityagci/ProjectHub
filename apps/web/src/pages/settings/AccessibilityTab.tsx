import { useState } from "react";
import { api, ApiError } from "../../lib/api.js";
import { setStoredReduceMotion, setStoredLargerText } from "../../lib/a11y.js";
import type { SettingsTabProps } from "./types.js";

/**
 * Instant apply, no Save button: each toggle writes straight to
 * localStorage + the DOM (apps/web/src/lib/a11y.ts), so the effect is
 * visible on this very page immediately, then syncs up to the DB in the
 * background.
 */
export default function AccessibilityTab({ settings, onSettingsChange }: SettingsTabProps) {
  const [reduceMotion, setReduceMotion] = useState(settings.accessibility.reduceMotion);
  const [largerText, setLargerText] = useState(settings.accessibility.largerText);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(next: { reduceMotion?: boolean; largerText?: boolean }) {
    setError(null);
    if (next.reduceMotion !== undefined) {
      setReduceMotion(next.reduceMotion);
      setStoredReduceMotion(next.reduceMotion);
    }
    if (next.largerText !== undefined) {
      setLargerText(next.largerText);
      setStoredLargerText(next.largerText);
    }
    try {
      const res = await api.patch<{ user: typeof settings }>("/api/auth/me/preferences", {
        accessibility: next,
      });
      onSettingsChange(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this preference.");
    }
  }

  return (
    <div className="ph-card ph-card-wide">
      <h1 style={{ fontSize: "1rem" }}>Accessibility</h1>
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        Personalize your experience.
      </p>
      {error && <div className="ph-alert ph-alert-error">{error}</div>}
      <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", marginBottom: "0.9rem" }}>
        <input
          type="checkbox"
          checked={reduceMotion}
          onChange={(e) => handleToggle({ reduceMotion: e.target.checked })}
        />
        <span>
          <strong>Reduce motion</strong>
          <div className="ph-subtitle" style={{ margin: 0 }}>
            Shorter animations and transitions
          </div>
        </span>
      </label>
      <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem" }}>
        <input
          type="checkbox"
          checked={largerText}
          onChange={(e) => handleToggle({ largerText: e.target.checked })}
        />
        <span>
          <strong>Larger text</strong>
          <div className="ph-subtitle" style={{ margin: 0 }}>
            Increase base font size for better readability
          </div>
        </span>
      </label>
    </div>
  );
}

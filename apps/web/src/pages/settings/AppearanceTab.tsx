import { useEffect, useState } from "react";
import { getStoredTheme, setStoredTheme, clearStoredTheme, type ThemeChoice } from "../../lib/theme.js";
import type { SettingsTabProps } from "./types.js";

type ThemeOption = ThemeChoice | "system";

/**
 * Instant-apply, no Save button (see the Settings save-philosophy split) —
 * a friendlier radio-group presentation built directly on top of
 * apps/web/src/lib/theme.ts's existing logic, reused as-is rather than
 * duplicated.
 */
export default function AppearanceTab(_props: SettingsTabProps) {
  const [selection, setSelection] = useState<ThemeOption>("system");

  useEffect(() => {
    setSelection(getStoredTheme() ?? "system");
  }, []);

  function handleChange(option: ThemeOption) {
    setSelection(option);
    if (option === "system") {
      clearStoredTheme();
    } else {
      setStoredTheme(option);
    }
  }

  return (
    <div className="ph-card ph-card-wide">
      <h1 style={{ fontSize: "1rem" }}>Appearance</h1>
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        Choose your theme preference.
      </p>
      <div style={{ display: "grid", gap: "0.7rem" }}>
        <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem" }}>
          <input
            type="radio"
            name="themeChoice"
            checked={selection === "light"}
            onChange={() => handleChange("light")}
          />
          <span>
            <strong>Light</strong>
            <div className="ph-subtitle" style={{ margin: 0 }}>
              Always use light theme
            </div>
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem" }}>
          <input
            type="radio"
            name="themeChoice"
            checked={selection === "dark"}
            onChange={() => handleChange("dark")}
          />
          <span>
            <strong>Dark</strong>
            <div className="ph-subtitle" style={{ margin: 0 }}>
              Always use dark theme
            </div>
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem" }}>
          <input
            type="radio"
            name="themeChoice"
            checked={selection === "system"}
            onChange={() => handleChange("system")}
          />
          <span>
            <strong>System</strong>
            <div className="ph-subtitle" style={{ margin: 0 }}>
              Follow my device setting
            </div>
          </span>
        </label>
      </div>
    </div>
  );
}

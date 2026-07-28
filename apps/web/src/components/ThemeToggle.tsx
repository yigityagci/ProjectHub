import { useEffect, useState } from "react";
import { getEffectiveTheme, toggleTheme, type ThemeChoice } from "../lib/theme.js";

/**
 * Minimal light/dark theme toggle for the app shell, placed next to the
 * notification bell / logout button on every authenticated page (see
 * `apps/web/src/lib/theme.ts` for the persistence/default-to-system-
 * preference behavior this drives).
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeChoice>("light");

  useEffect(() => {
    setTheme(getEffectiveTheme());
  }, []);

  function handleClick() {
    setTheme(toggleTheme());
  }

  return (
    <button
      type="button"
      className="ph-button ph-button-secondary ph-theme-toggle"
      onClick={handleClick}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? "Light mode" : "Dark mode"}
    </button>
  );
}

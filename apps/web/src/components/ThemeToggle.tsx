import { useEffect, useState } from "react";
import { getEffectiveTheme, toggleTheme, type ThemeChoice } from "../lib/theme.js";
import { IconMoon, IconSun } from "./Icons.js";

/**
 * Minimal light/dark theme toggle for the app shell, placed next to the
 * notification bell / logout button on every authenticated page (see
 * `apps/web/src/lib/theme.ts` for the persistence/default-to-system-
 * preference behavior this drives). Rendered as an icon-only ghost button
 * (sun/moon) rather than a text button, matching the topbar's icon-first
 * treatment for secondary actions (see NotificationBell.tsx).
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
      className="ph-icon-only-btn ph-theme-toggle"
      onClick={handleClick}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
    </button>
  );
}

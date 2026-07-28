/**
 * Phase 7 light/dark theme system. Deliberately tiny: the actual color
 * values live entirely in CSS custom properties (`apps/web/src/styles.css`)
 * — this module only ever toggles which of those property sets is active,
 * by setting (or clearing) `<html data-theme="...">` and persisting an
 * explicit user choice in localStorage.
 *
 * Default behavior (no explicit choice stored yet): the `data-theme`
 * attribute is left unset entirely, so `styles.css`'s
 * `@media (prefers-color-scheme: dark)` rule alone decides light vs. dark,
 * exactly matching the system preference. Only once a user makes an
 * explicit choice via the toggle does this start forcing one or the other
 * regardless of system preference.
 */

export type ThemeChoice = "light" | "dark";

const STORAGE_KEY = "ph-theme";

function isThemeChoice(value: string | null): value is ThemeChoice {
  return value === "light" || value === "dark";
}

export function getStoredTheme(): ThemeChoice | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isThemeChoice(value) ? value : null;
  } catch {
    // localStorage can throw in some locked-down/private-browsing contexts;
    // fall back to "no explicit preference" rather than crash the app.
    return null;
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** The theme actually in effect right now (explicit choice, else system preference). */
export function getEffectiveTheme(): ThemeChoice {
  return getStoredTheme() ?? (systemPrefersDark() ? "dark" : "light");
}

function applyDomAttribute(theme: ThemeChoice | null): void {
  if (theme) {
    document.documentElement.setAttribute("data-theme", theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

/**
 * Applies whatever theme choice (if any) is already stored. Call once, as
 * early as possible on app load (see `apps/web/src/main.tsx`), so there's no
 * flash of the wrong theme before React mounts.
 */
export function initTheme(): void {
  applyDomAttribute(getStoredTheme());
}

/** Persists an explicit user choice and applies it immediately. */
export function setStoredTheme(theme: ThemeChoice): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Non-fatal: the theme still applies for this page load even if it
    // can't be persisted.
  }
  applyDomAttribute(theme);
}

/** Clears the explicit choice, reverting to following system preference. */
export function clearStoredTheme(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  applyDomAttribute(null);
}

export function toggleTheme(): ThemeChoice {
  const next: ThemeChoice = getEffectiveTheme() === "dark" ? "light" : "dark";
  setStoredTheme(next);
  return next;
}

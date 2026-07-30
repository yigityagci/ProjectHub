/**
 * Settings page accessibility + locale init, mirroring theme.ts's structure
 * exactly: try/catch-tolerant localStorage access, "no stored choice ⇒ let
 * CSS media queries decide" for the two boolean toggles, and a pre-paint
 * apply step wired into main.tsx alongside initTheme().
 *
 * Two-tier persistence (see docs/PHASES.md / the Settings architecture
 * handoff): localStorage here is only a pre-paint mirror so there's no
 * flash of un-adjusted motion/text-size and so a signed-out visitor still
 * gets *something* reasonable. The DB columns synced via
 * `PATCH /api/auth/me/preferences` are the durable, cross-device source of
 * truth — `applyPreferencesFromServer` is called right after
 * `GET /api/auth/me` resolves in App.tsx and overwrites whatever was here.
 */

const REDUCE_MOTION_KEY = "ph-reduce-motion";
const LARGER_TEXT_KEY = "ph-larger-text";
const LOCALE_KEY = "ph-locale";

function readBoolean(key: string): boolean | null {
  try {
    const value = window.localStorage.getItem(key);
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
  } catch {
    return null;
  }
}

function writeBoolean(key: string, value: boolean | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, String(value));
    }
  } catch {
    // Non-fatal: the DOM attribute below still applies for this page load.
  }
}

function applyDomBoolean(attr: string, value: boolean | null): void {
  if (value) {
    document.documentElement.setAttribute(attr, "true");
  } else {
    document.documentElement.removeAttribute(attr);
  }
}

export function getStoredReduceMotion(): boolean | null {
  return readBoolean(REDUCE_MOTION_KEY);
}

export function getStoredLargerText(): boolean | null {
  return readBoolean(LARGER_TEXT_KEY);
}

export function getStoredLocale(): string | null {
  try {
    return window.localStorage.getItem(LOCALE_KEY);
  } catch {
    return null;
  }
}

export function setStoredReduceMotion(value: boolean): void {
  writeBoolean(REDUCE_MOTION_KEY, value);
  applyDomBoolean("data-reduce-motion", value);
}

export function setStoredLargerText(value: boolean): void {
  writeBoolean(LARGER_TEXT_KEY, value);
  applyDomBoolean("data-larger-text", value);
}

export function setStoredLocale(locale: string): void {
  try {
    window.localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    // ignore
  }
  document.documentElement.lang = locale;
}

/** Applies whatever is already stored, as early as possible (see main.tsx). */
export function initA11y(): void {
  applyDomBoolean("data-reduce-motion", getStoredReduceMotion());
  applyDomBoolean("data-larger-text", getStoredLargerText());
  document.documentElement.lang = getStoredLocale() ?? "en";
}

export interface ServerPreferences {
  locale: string;
  accessibility: { reduceMotion: boolean; largerText: boolean };
}

/**
 * Syncs the DB-authoritative preferences (from GET /api/auth/me) DOWN into
 * localStorage + the DOM, called once right after that fetch resolves.
 */
export function applyPreferencesFromServer(settings: ServerPreferences): void {
  setStoredReduceMotion(settings.accessibility.reduceMotion);
  setStoredLargerText(settings.accessibility.largerText);
  setStoredLocale(settings.locale);
}

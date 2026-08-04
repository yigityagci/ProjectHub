/**
 * Personalization tab init, mirroring apps/web/src/lib/a11y.ts's structure
 * exactly: try/catch-tolerant localStorage access, a pre-paint apply step
 * wired into main.tsx alongside initA11y(), and an `applyPersonalizationFromServer`
 * called right after every GET /api/auth/me resolves. Kept as a separate
 * file from a11y.ts, which is chartered accessibility+locale only.
 *
 * Two-tier persistence, same rationale as a11y.ts: localStorage here is
 * only a pre-paint mirror (and, for defaultBoardView/defaultLandingPage, a
 * way for plain client components with no access to the fetched
 * UserSettings object — e.g. KanbanBoardPage, App.tsx's landing-page
 * redirect — to read the preference without their own fetch). The DB
 * columns synced via PATCH /api/auth/me/preferences remain the durable,
 * cross-device source of truth.
 *
 * KNOWN LIMITATION (mirrors a11y.ts's own documented locale tradeoff):
 * immediately after a user's very first login on a fresh browser,
 * ph-default-landing/ph-last-workspace aren't populated yet since nothing
 * has been visited yet — first login always lands on `/`. This is
 * acceptable; we don't widen the login response or CurrentUser to special-
 * case it.
 */

import { BOARD_VIEWS, LANDING_PAGES, type BoardView, type LandingPage } from "@projecthub/shared";

const COMPACT_MODE_KEY = "ph-compact-mode";
const DEFAULT_LANDING_KEY = "ph-default-landing";
const LAST_WORKSPACE_KEY = "ph-last-workspace";
const DEFAULT_BOARD_VIEW_KEY = "ph-default-board-view";

// Defense in depth: a stored workspace id gets interpolated directly into a
// route path by resolveLandingPath() below, so anything not shaped like a
// UUID is rejected rather than trusted, even though it can only ever have
// been written by setStoredLastWorkspaceId() with a real workspace id.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function writeBoolean(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Non-fatal: the DOM attribute below still applies for this page load.
  }
}

function applyDomBoolean(attr: string, value: boolean): void {
  if (value) {
    document.documentElement.setAttribute(attr, "true");
  } else {
    document.documentElement.removeAttribute(attr);
  }
}

export function getStoredCompactMode(): boolean {
  return readBoolean(COMPACT_MODE_KEY) ?? false;
}

export function setStoredCompactMode(value: boolean): void {
  writeBoolean(COMPACT_MODE_KEY, value);
  applyDomBoolean("data-compact-mode", value);
}

export function getStoredLandingPage(): LandingPage | null {
  try {
    const value = window.localStorage.getItem(DEFAULT_LANDING_KEY);
    return (LANDING_PAGES as readonly string[]).includes(value ?? "") ? (value as LandingPage) : null;
  } catch {
    return null;
  }
}

export function setStoredLandingPage(value: LandingPage): void {
  try {
    window.localStorage.setItem(DEFAULT_LANDING_KEY, value);
  } catch {
    // ignore
  }
}

export function getStoredLastWorkspaceId(): string | null {
  try {
    const value = window.localStorage.getItem(LAST_WORKSPACE_KEY);
    return value && UUID_SHAPE.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function setStoredLastWorkspaceId(workspaceId: string): void {
  try {
    window.localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);
  } catch {
    // ignore
  }
}

export function clearStoredLastWorkspaceId(): void {
  try {
    window.localStorage.removeItem(LAST_WORKSPACE_KEY);
  } catch {
    // ignore
  }
}

export function getStoredDefaultBoardView(): BoardView | null {
  try {
    const value = window.localStorage.getItem(DEFAULT_BOARD_VIEW_KEY);
    return (BOARD_VIEWS as readonly string[]).includes(value ?? "") ? (value as BoardView) : null;
  } catch {
    return null;
  }
}

export function setStoredDefaultBoardView(value: BoardView): void {
  try {
    window.localStorage.setItem(DEFAULT_BOARD_VIEW_KEY, value);
  } catch {
    // ignore
  }
}

/** Applies whatever is already stored, as early as possible (see main.tsx). */
export function initPersonalization(): void {
  applyDomBoolean("data-compact-mode", getStoredCompactMode());
}

export interface ServerPersonalizationPreferences {
  personalization: {
    defaultBoardView: string;
    defaultLandingPage: string;
    compactMode: boolean;
    showKeyboardShortcutsReference: boolean;
  };
}

/**
 * Syncs the DB-authoritative preferences (from GET /api/auth/me) DOWN into
 * localStorage + the DOM, called once right after that fetch resolves —
 * same call sites as a11y.ts's applyPreferencesFromServer (App.tsx and
 * SettingsPage.tsx).
 */
export function applyPersonalizationFromServer(settings: ServerPersonalizationPreferences): void {
  setStoredCompactMode(settings.personalization.compactMode);
  setStoredLandingPage(
    (LANDING_PAGES as readonly string[]).includes(settings.personalization.defaultLandingPage)
      ? (settings.personalization.defaultLandingPage as LandingPage)
      : "workspaces",
  );
  setStoredDefaultBoardView(
    (BOARD_VIEWS as readonly string[]).includes(settings.personalization.defaultBoardView)
      ? (settings.personalization.defaultBoardView as BoardView)
      : "board",
  );
}

/**
 * Resolves where a fresh page load of `/` should land, per the user's
 * stored `defaultLandingPage` preference. Returns "/" (no redirect) unless
 * the preference is "projects" AND a UUID-shaped last-visited workspace id
 * is on hand — see getStoredLastWorkspaceId()'s own defense-in-depth check.
 */
export function resolveLandingPath(): string {
  const landingPage = getStoredLandingPage();
  const lastWorkspaceId = getStoredLastWorkspaceId();
  if (landingPage === "projects" && lastWorkspaceId) {
    return `/workspace/${lastWorkspaceId}/projects`;
  }
  return "/";
}

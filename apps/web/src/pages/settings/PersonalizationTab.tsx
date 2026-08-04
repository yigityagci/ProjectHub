import { useEffect, useState } from "react";
import { BOARD_VIEWS, LANDING_PAGES, type BoardView, type LandingPage } from "@projecthub/shared";
import { api, ApiError } from "../../lib/api.js";
import { IconX } from "../../components/Icons.js";
import {
  setStoredCompactMode,
  setStoredLandingPage,
  setStoredDefaultBoardView,
} from "../../lib/personalization.js";
import type { SettingsTabProps } from "./types.js";

/**
 * Instant apply, no Save button (same philosophy as AccessibilityTab):
 * every control writes its optimistic local value immediately, applies any
 * DOM/localStorage side effect it owns, then PATCHes
 * /api/auth/me/preferences in the background. A failure reverts the
 * optimistic value and shows an inline error scoped to that one control.
 *
 * Deliberately distinct in content from the other three "look and feel"
 * tabs: Appearance is the light/dark theme, Language & Region is locale,
 * Accessibility is motion/text-size. This tab is about how you *work* —
 * default views, density, and the keyboard-shortcuts reference — not how
 * things look or what language they're in.
 */

const BOARD_VIEW_LABELS: Record<BoardView, string> = {
  board: "Board",
  list: "List",
  calendar: "Calendar",
};

// Enum semantics (packages/shared's LANDING_PAGES) intentionally don't
// match this UI copy 1:1 — "workspaces" is the neutral "Your workspaces
// list" default; "projects" means "jump straight back into whichever
// workspace you last visited" (see resolveLandingPath() in
// lib/personalization.ts).
const LANDING_PAGE_LABELS: Record<LandingPage, string> = {
  workspaces: "Your workspaces list",
  projects: "Last visited workspace",
};

const SHORTCUTS = [
  { keys: "?", description: "Open this shortcuts reference" },
  { keys: "Esc", description: "Close a modal or dialog" },
  { keys: "Enter", description: "Submit the focused form" },
];

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="ph-modal-overlay" onClick={onClose}>
      <div className="ph-modal" style={{ maxWidth: "480px" }} onClick={(e) => e.stopPropagation()}>
        <div className="ph-modal-header">
          <h2 style={{ margin: 0 }}>Keyboard shortcuts</h2>
          <button className="ph-modal-close" onClick={onClose} aria-label="Close">
            <IconX size={18} />
          </button>
        </div>
        <ul className="ph-assignee-list">
          {SHORTCUTS.map((s) => (
            <li key={s.keys}>
              <span>{s.description}</span>
              <span className="ph-badge">{s.keys}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function PersonalizationTab({ settings, onSettingsChange }: SettingsTabProps) {
  const [boardView, setBoardView] = useState<BoardView>(settings.personalization.defaultBoardView as BoardView);
  const [landingPage, setLandingPage] = useState<LandingPage>(
    settings.personalization.defaultLandingPage as LandingPage,
  );
  const [compactMode, setCompactMode] = useState(settings.personalization.compactMode);
  const [showShortcutsToggle, setShowShortcutsToggle] = useState(
    settings.personalization.showKeyboardShortcutsReference,
  );
  const [error, setError] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Global "?" hotkey, wired up only while the toggle is on — ignores the
  // key while focus is in a text input/textarea/contentEditable so typing
  // a literal "?" in a form never pops this open. Added once here rather
  // than duplicated elsewhere, since this is the only place that needs it.
  useEffect(() => {
    if (!showShortcutsToggle) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "?" || isTypingTarget(document.activeElement)) return;
      setShortcutsOpen(true);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showShortcutsToggle]);

  async function patch(
    body: Record<string, unknown>,
    revert: () => void,
  ) {
    setError(null);
    try {
      const res = await api.patch<{ user: typeof settings }>("/api/auth/me/preferences", {
        personalization: body,
      });
      onSettingsChange(res.user);
    } catch (err) {
      revert();
      setError(err instanceof ApiError ? err.message : "Could not save this preference.");
    }
  }

  function handleBoardViewChange(next: BoardView) {
    const previous = boardView;
    setBoardView(next);
    setStoredDefaultBoardView(next);
    patch({ defaultBoardView: next }, () => {
      setBoardView(previous);
      setStoredDefaultBoardView(previous);
    });
  }

  function handleLandingPageChange(next: LandingPage) {
    const previous = landingPage;
    setLandingPage(next);
    setStoredLandingPage(next);
    patch({ defaultLandingPage: next }, () => {
      setLandingPage(previous);
      setStoredLandingPage(previous);
    });
  }

  function handleCompactModeChange(next: boolean) {
    const previous = compactMode;
    setCompactMode(next);
    setStoredCompactMode(next);
    patch({ compactMode: next }, () => {
      setCompactMode(previous);
      setStoredCompactMode(previous);
    });
  }

  function handleShortcutsToggleChange(next: boolean) {
    const previous = showShortcutsToggle;
    setShowShortcutsToggle(next);
    patch({ showKeyboardShortcutsReference: next }, () => setShowShortcutsToggle(previous));
  }

  return (
    <div className="ph-card ph-card-wide">
      <h1 style={{ fontSize: "1rem" }}>Personalization</h1>
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        Tune how ProjectHub works for you — default views, density, and shortcuts.
      </p>
      {error && <div className="ph-alert ph-alert-error">{error}</div>}

      <div style={{ marginBottom: "1.25rem" }}>
        <strong>Default board view</strong>
        <div className="ph-subtitle" style={{ margin: "0 0 0.5rem" }}>
          Which view opens first when you visit a project's board.
        </div>
        <div className="ph-subnav" style={{ margin: 0 }}>
          {BOARD_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              className={`ph-subnav-link${boardView === v ? " ph-subnav-active" : ""}`}
              onClick={() => handleBoardViewChange(v)}
            >
              {BOARD_VIEW_LABELS[v]}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: "1.25rem" }}>
        <strong>Default landing page after login</strong>
        <div className="ph-subtitle" style={{ margin: "0 0 0.5rem" }}>
          Where you land right after signing in.
        </div>
        <div className="ph-subnav" style={{ margin: 0 }}>
          {LANDING_PAGES.map((p) => (
            <button
              key={p}
              type="button"
              className={`ph-subnav-link${landingPage === p ? " ph-subnav-active" : ""}`}
              onClick={() => handleLandingPageChange(p)}
            >
              {LANDING_PAGE_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: "1.25rem" }}>
        <strong>Task density</strong>
        <div className="ph-subtitle" style={{ margin: "0 0 0.5rem" }}>
          Compact mode reduces spacing on task cards and list rows so more fits on screen.
        </div>
        <div className="ph-subnav" style={{ margin: 0 }}>
          <button
            type="button"
            className={`ph-subnav-link${!compactMode ? " ph-subnav-active" : ""}`}
            onClick={() => handleCompactModeChange(false)}
          >
            Comfortable
          </button>
          <button
            type="button"
            className={`ph-subnav-link${compactMode ? " ph-subnav-active" : ""}`}
            onClick={() => handleCompactModeChange(true)}
          >
            Compact
          </button>
        </div>
      </div>

      <div>
        <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", marginBottom: "0.75rem" }}>
          <input
            type="checkbox"
            checked={showShortcutsToggle}
            onChange={(e) => handleShortcutsToggleChange(e.target.checked)}
          />
          <span>
            <strong>Keyboard shortcuts reference</strong>
            <div className="ph-subtitle" style={{ margin: 0 }}>
              Press "?" anywhere to open a quick reference of keyboard shortcuts.
            </div>
          </span>
        </label>
        <button type="button" className="ph-button ph-button-secondary" style={{ width: "auto" }} onClick={() => setShortcutsOpen(true)}>
          View shortcuts
        </button>
      </div>

      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}

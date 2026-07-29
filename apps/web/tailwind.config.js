/** @type {import('tailwindcss').Config} */
export default {
  // Tailwind is added purely as a utility layer for structural/responsive
  // layout (flex, grid, gap, breakpoints, truncate, etc.) on top of the
  // existing hand-written `ph-*` design system in `src/styles.css`. Colors,
  // spacing scale for components, and theming continue to come from the
  // `--ph-*` CSS custom properties (light/dark) defined there — Tailwind's
  // theme is left at its default palette/scale rather than duplicating that
  // system, so there is a single source of truth for brand colors.
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Thin bridge so Tailwind utility classes (e.g. `bg-ph-surface`,
        // `text-ph-muted`) can be used if ever convenient, without
        // duplicating the actual color values — they resolve straight
        // through to the existing CSS custom properties.
        "ph-primary": "var(--ph-primary)",
        "ph-secondary": "var(--ph-secondary)",
        "ph-success": "var(--ph-success)",
        "ph-error": "var(--ph-error)",
        "ph-warning": "var(--ph-warning)",
        "ph-info": "var(--ph-info)",
        "ph-bg": "var(--ph-bg)",
        "ph-text": "var(--ph-text)",
        "ph-muted": "var(--ph-muted)",
        "ph-border": "var(--ph-border)",
        "ph-surface": "var(--ph-surface)",
      },
    },
  },
  plugins: [],
  // The app's own `ph-*` classes already provide colors/borders/shadows;
  // Tailwind's base "preflight" reset only strips default browser styling
  // (which every `ph-*` component already assumes/overrides), so it's kept
  // on rather than disabled.
};

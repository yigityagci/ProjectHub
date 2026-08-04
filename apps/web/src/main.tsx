import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.js";
import { initTheme } from "./lib/theme.js";
import { initA11y } from "./lib/a11y.js";
import { initPersonalization } from "./lib/personalization.js";
import "./styles.css";

// Applies any explicitly-stored light/dark theme choice before the first
// paint, so there's no flash of the wrong theme. If no explicit choice has
// ever been made, this is a no-op and styles.css's own
// `prefers-color-scheme` media query alone decides the theme.
initTheme();

// Same pre-paint rationale as initTheme() above, for reduce-motion/
// larger-text/locale (see apps/web/src/lib/a11y.ts).
initA11y();

// Same pre-paint rationale, for compact-mode (see apps/web/src/lib/personalization.ts).
initPersonalization();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

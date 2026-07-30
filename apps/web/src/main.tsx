import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.js";
import { initTheme } from "./lib/theme.js";
import { initA11y } from "./lib/a11y.js";
import "./styles.css";

// Applies any explicitly-stored light/dark theme choice before the first
// paint, so there's no flash of the wrong theme. If no explicit choice has
// ever been made, this is a no-op and styles.css's own
// `prefers-color-scheme` media query alone decides the theme.
initTheme();

// Same pre-paint rationale as initTheme() above, for reduce-motion/
// larger-text/locale (see apps/web/src/lib/a11y.ts).
initA11y();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

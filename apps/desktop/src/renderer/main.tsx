import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyRememberedTheme } from "./lib/theme";
import "./styles.css";

// Before the first render, so a stored Light or Dark theme is drawn from the first frame.
applyRememberedTheme();

const root = document.getElementById("root");

if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

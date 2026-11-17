import "@fontsource-variable/geist";
import "@fontsource-variable/bricolage-grotesque/standard.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/jetbrains-mono";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/base.css";
import "./styles/browse.css";
import "./styles/player.css";
import "./styles/frost.css";
import "./styles/trailer.css";
import "./styles/sources.css";
import { installPointerLight } from "./lib/pointerLight";
import { installGamepad } from "./lib/gamepad";
import { kick as retryScrobbles } from "./lib/scrobble";

installPointerLight();
installGamepad();
// Finishes that couldn't reach a tracker last time (offline) go up now.
setTimeout(retryScrobbles, 8000);

// Dev-only hooks for the native test harness (src-tauri/src/lib.rs, ABX_JS_TEST).
if (import.meta.env.DEV) {
  Promise.all([import("./sources/registry"), import("./sources/native"), import("./sources/anime-direct"), import("hls.js"), import("./lib/enhance")]).then(([r, n, a, h, e]) => {
    (window as any).__abx = { ...r, ...n, animeDirectProvider: a.animeDirectProvider, Hls: h.default, ...e };
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

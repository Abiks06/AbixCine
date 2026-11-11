import "@fontsource-variable/geist";
import "@fontsource-variable/sora";
import "@fontsource-variable/jetbrains-mono";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

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

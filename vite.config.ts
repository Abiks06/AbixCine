import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * JASSUB ships fallback `new URL("./wasm/jassub-worker.wasm", import.meta.url)` references to its
 * legacy non-SIMD engine, which Vite always copies into the build (2 MB + 80 KB of glue). The app
 * passes the modern build for both slots (SubtitleOverlay.tsx) and WebView2 always has WASM SIMD,
 * so those fallbacks are dead: drop them so the files leave the installer too.
 */
function dropLegacyJassub(): Plugin {
  return {
    name: "abx-drop-legacy-jassub",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]jassub[\\/]dist[\\/]jassub\.js(?:\?.*)?$/.test(id)) return null;
      const next = code
        .replace(/new URL\(\s*['"]\.\/wasm\/jassub-worker\.wasm['"]\s*,\s*import\.meta\.url\s*\)\.href/g, '""')
        .replace(/new URL\(\s*['"]\.\/wasm\/jassub-worker\.js['"]\s*,\s*import\.meta\.url\s*\)\.href/g, '""');
      return next === code ? null : { code: next, map: null };
    },
  };
}

// Tauri expects a fixed port in dev and no screen clearing so Rust errors stay visible.
export default defineConfig({
  plugins: [react(), dropLegacyJassub()],
  clearScreen: false,
  // Never watch the Rust side: cargo locks files in target/ and the watcher would crash.
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/server/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["jassub"],
  },
  build: {
    target: "chrome110", // WebView2 is evergreen Chromium
    sourcemap: false,
    // Heavy, rarely-changing libraries live in their own files: they stay cached across app
    // updates, and the startup bundle carries only what the first screen needs.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler|@remix-run)[\\/]/.test(id)) return "react";
          if (id.includes("@tauri-apps")) return "tauri";
          if (id.includes("@fontsource")) return undefined; // CSS + font files, handled by Vite
          if (id.includes("hls.js")) return "hls";
          if (id.includes("shaka-player")) return "shaka";
          if (id.includes("anime4k-webgpu")) return "anime4k";
          return undefined;
        },
      },
    },
    // The player engines and the upscaler are big by nature and load only on demand.
    chunkSizeWarningLimit: 1000,
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port in dev and no screen clearing so Rust errors stay visible.
export default defineConfig({
  plugins: [react()],
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

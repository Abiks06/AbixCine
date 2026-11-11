import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port in dev and no screen clearing so Rust errors stay visible.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Never watch the Rust side: cargo locks files in target/ and the watcher would crash.
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/server/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome110", // WebView2 is evergreen Chromium
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});

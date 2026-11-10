import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port in dev and no screen clearing so Rust errors stay visible.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome110", // WebView2 is evergreen Chromium
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});

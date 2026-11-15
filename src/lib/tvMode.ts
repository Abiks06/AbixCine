import { isTauri } from "@tauri-apps/api/core";

/**
 * TV mode: the whole interface reflowed larger for a screen across the room. It uses the WebView's
 * own zoom (like Ctrl +), so layouts reflow rather than overflow, and adds the big controller focus
 * ring. "auto" turns it on while a game controller is connected.
 */
export type TvMode = "off" | "auto" | "on";

const TV_ZOOM = 1.5;
let applied = 1;
let padConnected = false;
let mode: TvMode = "off";

async function setZoom(scale: number) {
  if (scale === applied) return;
  applied = scale;
  document.documentElement.classList.toggle("tv", scale > 1);
  if (isTauri()) {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().setZoom(scale);
      return;
    } catch {
      /* fall back to CSS zoom below */
    }
  }
  // Browser preview: CSS zoom on the root reflows like page zoom in Chromium.
  (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = scale > 1 ? String(scale) : "";
}

function update() {
  const on = mode === "on" || (mode === "auto" && padConnected);
  void setZoom(on ? TV_ZOOM : 1);
}

export function setTvMode(next: TvMode) {
  mode = next;
  update();
}

let installed = false;
/** Watch controllers for "auto". Safe to call more than once. */
export function installTvMode() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const refresh = () => {
    padConnected = [...(navigator.getGamepads?.() ?? [])].some((p) => p?.connected);
    update();
  };
  window.addEventListener("gamepadconnected", refresh);
  window.addEventListener("gamepaddisconnected", refresh);
  refresh();
}

import { invoke, isTauri } from "@tauri-apps/api/core";

/** Open a web link in the system browser instead of a WebView child window. */
export function openExternal(url: string): void {
  if (isTauri()) {
    void invoke("open_external", { url }).catch(() => {});
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

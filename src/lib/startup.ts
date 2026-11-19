import { invoke, isTauri } from "@tauri-apps/api/core";
import { toast } from "./toast";

/** Mirrors diagnostics::StartupInfo in src-tauri/src/diagnostics.rs. */
interface StartupInfo {
  safeMode: boolean;
  safeModeNew: boolean;
  logPath?: string | null;
}

let reported = false;

/**
 * Tell the native side the window rendered, so the next launch doesn't fall back to safe
 * graphics mode; and say so when this launch is running in it.
 */
export function reportAppReady() {
  if (reported || !isTauri()) return;
  reported = true;
  invoke<StartupInfo>("app_ready")
    .then((info) => {
      if (!info?.safeMode) return;
      toast(
        info.safeModeNew
          ? "The last launch didn't finish starting, so AbixCine is using safe graphics mode (GPU off). Picture enhancement may be unavailable."
          : "Safe graphics mode is on (GPU off).",
        {
          action: {
            label: "Use GPU again",
            run: () => {
              void invoke("reset_safe_mode").then(() => toast("GPU will be used again from the next launch."));
            },
          },
        },
      );
    })
    .catch(() => {});
}

/** Uncaught renderer errors go to startup.log too, where a remote user can find them. */
export function installErrorLog() {
  if (!isTauri()) return;
  const send = (message: string) => void invoke("log_frontend_error", { message }).catch(() => {});
  window.addEventListener("error", (e) => send(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    send(`unhandled rejection: ${r instanceof Error ? `${r.message}\n${r.stack ?? ""}` : String(r)}`);
  });
}

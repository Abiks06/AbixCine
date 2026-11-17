import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { isYouTubeOrigin, parseTrailerMessage, trailerEmbedUrl, trailerWatchUrl } from "../lib/trailer";
import { Icon } from "./Icon";

/** Open a web link in the system browser (never through `target=_blank`, which WebView2 hands to the shell). */
export function openExternal(url: string) {
  if (isTauri()) {
    void invoke("open_external", { url }).catch(() => {});
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** How long the player gets to report in before we offer the browser as a way out. */
const SLOW_MS = 9000;
const CLOSE_MS = 170;

const FOCUSABLE = 'button:not([disabled]), a[href], iframe, [tabindex]:not([tabindex="-1"])';

/** Pause whatever media is playing behind the dialog and hand back a function that resumes it. */
function hushBackground(): () => void {
  const paused: HTMLMediaElement[] = [];
  document.querySelectorAll<HTMLMediaElement>("video, audio").forEach((el) => {
    if (!el.paused && !el.ended) {
      el.pause();
      paused.push(el);
    }
  });
  return () => paused.forEach((el) => el.isConnected && void el.play().catch(() => {}));
}

/**
 * The trailer, played in place: a frosted pane over the page with the YouTube embed. Closes on
 * Escape, a click on the backdrop or the close button; focus stays inside and goes back to the
 * opener; the page doesn't scroll underneath; background media pauses while it's open.
 */
export function TrailerModal({ id, title, onClose }: { id: string; title?: string; onClose: () => void }) {
  const [closing, setClosing] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "slow" | "error">("loading");
  const [code, setCode] = useState<number | null>(null);
  const pane = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const timer = useRef<number>(0);

  const reduce = () =>
    document.documentElement.classList.contains("reduce-motion") ||
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const close = useCallback(() => {
    if (closing) return;
    setClosing(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(onClose, reduce() ? 0 : CLOSE_MS);
  }, [closing, onClose]);

  // Scroll lock, background hush, focus in and back out.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevPad = body.style.paddingRight;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (gap > 0) body.style.paddingRight = `${gap}px`;
    const resume = hushBackground();
    closeBtn.current?.focus({ preventScroll: true });
    return () => {
      window.clearTimeout(timer.current);
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPad;
      resume();
      opener?.focus?.({ preventScroll: true });
    };
  }, []);

  // Escape + focus trap. Capture phase so page-level Escape handlers (Watch/Title "go back") don't fire.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab" || !pane.current) return;
      const items = Array.from(pane.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!pane.current.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  // Tab inside the (cross-origin) player never reaches our keydown handler: if focus escapes the
  // pane from there, pull it back.
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      if (pane.current && e.target instanceof Node && !pane.current.contains(e.target)) closeBtn.current?.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);

  // Player state from the YouTube iframe API, and a timeout so a silent failure isn't a dead end.
  useEffect(() => {
    setState("loading");
    setCode(null);
    const onMsg = (e: MessageEvent) => {
      if (!isYouTubeOrigin(e.origin) || e.source !== frame.current?.contentWindow) return;
      const s = parseTrailerMessage(e.data);
      if (!s) return;
      if (s.kind === "ready") setState((x) => (x === "error" ? x : "ready"));
      else {
        setCode(s.code);
        setState("error");
      }
    };
    window.addEventListener("message", onMsg);
    const slow = window.setTimeout(() => setState((x) => (x === "loading" ? "slow" : x)), SLOW_MS);
    return () => {
      window.removeEventListener("message", onMsg);
      window.clearTimeout(slow);
    };
  }, [id]);

  // The iframe API only starts talking after the host says it is listening.
  const hello = () => {
    const w = frame.current?.contentWindow;
    if (!w) return;
    const msg = JSON.stringify({ event: "listening", id: 1, channel: "widget" });
    for (const t of [0, 400, 1500]) window.setTimeout(() => w.postMessage(msg, "*"), t);
  };

  const watch = trailerWatchUrl(id);
  const label = title ? `${title} — trailer` : "Trailer";

  return createPortal(
    <div
      className={`trailer-scrim${closing ? " closing" : ""}`}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div ref={pane} className="trailer-pane" role="dialog" aria-modal="true" aria-label={label}>
        <div className="trailer-head">
          <span className="trailer-title">
            <Icon name="film" size={15} />
            <span>{title ?? "Trailer"}</span>
          </span>
          <div className="trailer-tools">
            <button type="button" className="btn glass sm" onClick={() => openExternal(watch)}>
              YouTube <Icon name="arrowUR" size={13} />
            </button>
            <button ref={closeBtn} type="button" className="btn glass icon sm trailer-x" onClick={close} aria-label="Close trailer" title="Close (Esc)">
              <Icon name="x" size={17} />
            </button>
          </div>
        </div>
        <div className="trailer-frame">
          {state !== "error" && (
            <iframe
              ref={frame}
              src={trailerEmbedUrl(id, window.location.origin)}
              title={label}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={hello}
            />
          )}
          {state === "loading" && <div className="trailer-wait" aria-hidden><span className="mini-spin" /></div>}
          {state === "error" && (
            <div className="trailer-fail" role="alert">
              <p className="trailer-fail-t">This trailer can't play inside AbixCine.</p>
              <p className="muted">
                {code === 101 || code === 150 ? "Its owner only allows it on YouTube." : code === 100 ? "YouTube says the video is gone." : `YouTube refused the embedded player${code ? ` (error ${code})` : ""}.`}
              </p>
              <button type="button" className="btn play" onClick={() => openExternal(watch)}>
                <Icon name="play" size={15} /> Watch on YouTube
              </button>
            </div>
          )}
        </div>
        {state === "slow" && (
          <p className="trailer-hint">
            Not starting? <button type="button" className="trailer-link" onClick={() => openExternal(watch)}>Open it on YouTube</button>
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

import { Component, type ErrorInfo, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createHashRouter, Outlet, RouterProvider, useLocation, useNavigationType, useRouteError } from "react-router-dom";
import { CardHoverPreview } from "./components/CardHoverPreview";
import { CommandPalette } from "./components/CommandPalette";
import { DownloadFolderModal } from "./components/DownloadFolderModal";
import { QuickDossier } from "./components/QuickDossier";
import { Splash } from "./components/Splash";
import { TitleBar } from "./components/TitleBar";
import { Toasts } from "./components/Toasts";
import { UpdateToast } from "./components/UpdateToast";
import { bootAccount, useAuth } from "./lib/account";
import { closeDossier, lookupMedia, openDossier } from "./lib/dossier";
import { initDownloads } from "./lib/downloads";
import { closeHoverPreviewNow } from "./lib/hoverPreview";
import { syncThemeLight } from "./lib/light";
import { getSettings, useSettings } from "./lib/settings";
import { applyThemeToDom, resolveTheme } from "./lib/themes";
import { installErrorLog, reportAppReady } from "./lib/startup";
import { installTvMode, setTvMode } from "./lib/tvMode";
import { Auth } from "./pages/Auth";
import { Home } from "./pages/Home";

/**
 * Every screen but Home is its own chunk. The router's `lazy` waits for the chunk before it
 * commits the navigation, so there is no spinner flash and view transitions still morph; and all
 * of them are fetched in the background once the app is idle, so the wait is normally zero.
 */
const pages = {
  browse: () => import("./pages/Browse"),
  title: () => import("./pages/Title"),
  search: () => import("./pages/Search"),
  library: () => import("./pages/Library"),
  list: () => import("./pages/MyList"),
  settings: () => import("./pages/Settings"),
  watch: () => import("./pages/Watch"),
};
function preloadPages() {
  const run = () => Object.values(pages).forEach((load) => void load().catch(() => {}));
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}

class RouteErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("AbixCine route error:", error, info);
  }

  render() {
    if (this.state.error) return <Crash error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}

function Crash({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : "unexpected error";
  return (
    <div className="page empty">
      <h3>This screen hit a snag</h3>
      <p>{msg || "unexpected error"}</p>
      <div className="acts" style={{ justifyContent: "center" }}>
        <button className="btn play sm" onClick={() => (onRetry ? onRetry() : window.location.reload())}>Try again</button>
        <button
          className="btn glass sm"
          onClick={() => {
            window.location.hash = "#/";
            if (!onRetry) window.location.reload();
            else onRetry();
          }}
        >
          Back to Home
        </button>
      </div>
    </div>
  );
}

/** A chunk that failed to load (offline mid-session) or a loader that threw. */
function RouteCrash() {
  return <Crash error={useRouteError()} />;
}

installErrorLog();
void bootAccount();
const osReduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const SKIP_SPLASH = getSettings().reduceMotion || osReduced();
const SCROLL_MEMORY = 60;

function Shell() {
  const loc = useLocation();
  const s = useSettings();
  const { user, guest } = useAuth();
  const inApp = !!user || !!guest;
  const watching = loc.pathname.startsWith("/watch/");
  const main = useRef<HTMLElement>(null);
  const [palette, setPalette] = useState(false);

  // First render reached: this launch started fine (see src-tauri/src/diagnostics.rs).
  useEffect(() => reportAppReady(), []);
  useEffect(() => {
    void initDownloads();
  }, []);

  // Reduced motion lives on <html>, where it can reach ::view-transition pseudo-elements too.
  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", s.reduceMotion);
  }, [s.reduceMotion]);

  // Apply selected cinema color grade & dynamic lighting rule.
  useEffect(() => {
    applyThemeToDom(resolveTheme(s.theme), s.dynamicLight !== false);
    syncThemeLight();
  }, [s.theme, s.dynamicLight]);

  // TV mode (lib/tvMode): larger everything, on its own or while a controller is connected.
  useEffect(() => {
    installTvMode();
    setTvMode(s.tvMode ?? "off");
  }, [s.tvMode]);

  useEffect(() => {
    if (inApp) preloadPages();
  }, [inApp]);

  // Scroll memory: going Back lands where you were; a new page starts at the top.
  // In a layout effect so the position is set before the view transition snapshots the page.
  const navType = useNavigationType();
  const scrolls = useRef(new Map<string, number>());
  // Which way the page change goes, for the view transition's depth (base.css): a new page comes
  // forward out of the old one, Back recedes. Set in a layout effect, inside the transition's
  // update, so the pseudo-elements read it before they start animating.
  useLayoutEffect(() => {
    document.documentElement.dataset.nav = navType === "POP" ? "back" : "forward";
  }, [loc.key, navType]);
  useLayoutEffect(() => {
    const el = main.current;
    if (!el) return;
    const want = navType === "POP" ? scrolls.current.get(loc.key) ?? 0 : 0;
    el.scrollTop = want;
    app.current?.toggleAttribute("data-scrolled", want > 24);
    if (!want) return;
    // Rows may still be mounting from the cache: keep trying for a moment until the page is tall
    // enough, but hand control back the instant the viewer scrolls for themselves.
    let tries = 0;
    let raf = 0;
    const stop = () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("wheel", stop);
      el.removeEventListener("pointerdown", stop);
      window.removeEventListener("keydown", stop);
    };
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("pointerdown", stop, { passive: true });
    window.addEventListener("keydown", stop);
    raf = requestAnimationFrame(function again() {
      if (Math.abs(el.scrollTop - want) < 2 || ++tries > 40) return stop();
      el.scrollTop = want;
      raf = requestAnimationFrame(again);
    });
    return stop;
    // Keyed on the path only: the search page rewrites ?q= as you type and must not jump to the top.
  }, [loc.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  const app = useRef<HTMLDivElement>(null);
  const scrollRaf = useRef(0);
  const scrolledRef = useRef(false);
  useEffect(() => () => cancelAnimationFrame(scrollRaf.current), []);
  const onScroll = () => {
    closeHoverPreviewNow();
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      const el = main.current;
      if (!el) return;
      const m = scrolls.current;
      m.delete(loc.key);
      m.set(loc.key, el.scrollTop);
      if (m.size > SCROLL_MEMORY) m.delete(m.keys().next().value as string);
      // Only touch the DOM attribute when crossing the threshold (attribute, not state: no re-render per scroll).
      const scrolled = el.scrollTop > 24;
      if (scrolled !== scrolledRef.current) {
        scrolledRef.current = scrolled;
        app.current?.toggleAttribute("data-scrolled", scrolled);
      }
    });
  };

  // Never strand the window in fullscreen once you leave the player.
  useEffect(() => {
    if (watching) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    if (isTauri()) {
      void invoke<boolean>("get_window_fullscreen")
        .then((full) => (full ? invoke("set_window_fullscreen", { fullscreen: false }) : undefined))
        .catch(() =>
          getCurrentWindow()
            .isFullscreen()
            .then((f) => (f ? getCurrentWindow().setFullscreen(false) : undefined))
            .catch(() => {}),
        );
    }
  }, [watching]);

  useEffect(() => {
    closeDossier();
    closeHoverPreviewNow();
  }, [loc.pathname]);

  useEffect(() => {
    if (!inApp) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      // "/" opens search from anywhere you aren't typing (the player has its own keys).
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !location.hash.startsWith("#/watch/")) {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if ((e.key === "i" || e.key === "I") && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !location.hash.startsWith("#/watch/") && !document.querySelector(".palette-scrim")) {
        const key = t?.closest<HTMLElement>("[data-media-key]")?.dataset.mediaKey;
        const hit = key ? lookupMedia(key) : undefined;
        if (hit) {
          e.preventDefault();
          openDossier(hit);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inApp]);

  return (
    <div ref={app} className={`app ${watching ? "is-watching" : ""}`}>
      <div className="light" aria-hidden />
      <Splash skip={SKIP_SPLASH} />
      {!inApp ? (
        <Auth />
      ) : (
        <>
          {!watching && <TitleBar onOpenPalette={() => setPalette(true)} />}
          <main ref={main} className="main" onScroll={onScroll}>
            <RouteErrorBoundary resetKey={loc.pathname}>
              <Outlet />
            </RouteErrorBoundary>
          </main>
          <QuickDossier />
          <CardHoverPreview />
          <DownloadFolderModal />
          <CommandPalette open={palette} onClose={() => setPalette(false)} />
          {!watching && <UpdateToast />}
          <Toasts />
        </>
      )}
    </div>
  );
}

const router = createHashRouter([
  {
    element: <Shell />,
    errorElement: <RouteCrash />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/movies", lazy: () => pages.browse().then((m) => ({ element: <m.Browse key="movie" kind="movie" /> })) },
      { path: "/series", lazy: () => pages.browse().then((m) => ({ element: <m.Browse key="tv" kind="tv" /> })) },
      { path: "/anime", lazy: () => pages.browse().then((m) => ({ Component: m.Anime })) },
      { path: "/list", lazy: () => pages.list().then((m) => ({ Component: m.MyList })) },
      { path: "/library", lazy: () => pages.library().then((m) => ({ Component: m.Library })) },
      { path: "/search", lazy: () => pages.search().then((m) => ({ Component: m.Search })) },
      { path: "/settings", lazy: () => pages.settings().then((m) => ({ Component: m.Settings })) },
      { path: "/title/:key", lazy: () => pages.title().then((m) => ({ Component: m.Title })) },
      { path: "/watch/:key", lazy: () => pages.watch().then((m) => ({ Component: m.Watch })) },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} fallbackElement={<div className="app" />} />;
}

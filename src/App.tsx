import { useEffect, useLayoutEffect, useRef, useState, lazy, Suspense } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createHashRouter, Outlet, RouterProvider, useLocation, useNavigationType } from "react-router-dom";
import { CommandPalette } from "./components/CommandPalette";
import { Splash } from "./components/Splash";
import { Rail } from "./components/Rail";
import { TitleBar } from "./components/TitleBar";
import { Toasts } from "./components/Toasts";
import { UpdateToast } from "./components/UpdateToast";
import { bootAccount, useAuth } from "./lib/account";
import { getSettings, useSettings } from "./lib/settings";
import { Auth } from "./pages/Auth";
import { Anime, Browse } from "./pages/Browse";
import { Home } from "./pages/Home";
import { Library } from "./pages/Library";
import { MyList } from "./pages/MyList";
import { Search } from "./pages/Search";
import { Settings } from "./pages/Settings";
import { Title } from "./pages/Title";

// The player pulls in hls.js (~400 kB), so load it only when you press play.
const Watch = lazy(() => import("./pages/Watch").then((m) => ({ default: m.Watch })));

bootAccount();
const SKIP_SPLASH = getSettings().reduceMotion || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function Shell() {
  const loc = useLocation();
  const s = useSettings();
  const { user } = useAuth();
  const watching = loc.pathname.startsWith("/watch/");
  const main = useRef<HTMLElement>(null);
  const [palette, setPalette] = useState(false);

  // Scroll memory: going Back lands where you were; a new page starts at the top.
  // In a layout effect so the position is set before the view transition snapshots the page.
  const navType = useNavigationType();
  const scrolls = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = main.current;
    if (!el) return;
    const want = navType === "POP" ? scrolls.current.get(loc.key) ?? 0 : 0;
    el.scrollTop = want;
    if (!want) return;
    // Rows may still be mounting from the cache: keep trying for a moment until the page is tall enough.
    let tries = 0;
    let raf = requestAnimationFrame(function again() {
      if (Math.abs(el.scrollTop - want) < 2 || ++tries > 40) return;
      el.scrollTop = want;
      raf = requestAnimationFrame(again);
    });
    return () => cancelAnimationFrame(raf);
    // Keyed on the path only: the search page rewrites ?q= as you type and must not jump to the top.
  }, [loc.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  const app = useRef<HTMLDivElement>(null);
  const onScroll = () => {
    const el = main.current;
    if (!el) return;
    scrolls.current.set(loc.key, el.scrollTop);
    // The title bar firms up once content slides beneath it (attribute, not state: no re-render per scroll).
    app.current?.toggleAttribute("data-scrolled", el.scrollTop > 24);
  };

  // Never strand the window in fullscreen once you leave the player.
  useEffect(() => {
    if (!watching && isTauri()) getCurrentWindow().setFullscreen(false).catch(() => {});
  }, [watching]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      // "/" opens search from anywhere you aren't typing (the player has its own keys).
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !location.hash.startsWith("#/watch/")) {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div ref={app} className={`app ${watching ? "is-watching" : ""} ${s.reduceMotion ? "reduce-motion" : ""}`}>
      <div className="light" aria-hidden />
      <div className="grain" aria-hidden />
      <Splash skip={SKIP_SPLASH} />
      {!user ? (
        <Auth />
      ) : (
        <>
          {!watching && <TitleBar onOpenPalette={() => setPalette(true)} />}
          {!watching && <Rail />}
          <main ref={main} className="main" onScroll={onScroll}>
            <Outlet />
          </main>
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
    children: [
      { path: "/", element: <Home /> },
      { path: "/movies", element: <Browse kind="movie" /> },
      { path: "/series", element: <Browse kind="tv" /> },
      { path: "/anime", element: <Anime /> },
      { path: "/list", element: <MyList /> },
      { path: "/library", element: <Library /> },
      { path: "/search", element: <Search /> },
      { path: "/settings", element: <Settings /> },
      { path: "/title/:key", element: <Title /> },
      {
        path: "/watch/:key",
        element: (
          <Suspense fallback={<div className="race-page"><span className="spin" /></div>}>
            <Watch />
          </Suspense>
        ),
      },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}

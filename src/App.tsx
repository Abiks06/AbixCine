import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { createHashRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { CommandPalette } from "./components/CommandPalette";
import { Splash } from "./components/Splash";
import { Rail } from "./components/Rail";
import { TitleBar } from "./components/TitleBar";
import { bootAccount, useAuth } from "./lib/account";
import { bootUpdates } from "./lib/updater";
import { bootAlerts } from "./lib/alerts";
import { UpdateToast, WhatsNew } from "./components/Updates";
import { getSettings, useSettings } from "./lib/settings";
import { Auth } from "./pages/Auth";
import { Anime, Browse } from "./pages/Browse";
import { Home } from "./pages/Home";
import { Library } from "./pages/Library";
import { History } from "./pages/History";
import { MyList } from "./pages/MyList";
import { Search } from "./pages/Search";
import { Settings } from "./pages/Settings";
import { Title } from "./pages/Title";

// The player pulls in hls.js (~600 kB), so load it only when you press play.
const Watch = lazy(() => import("./pages/Watch").then((m) => ({ default: m.Watch })));

void bootAccount();
void bootUpdates();
bootAlerts();
const SKIP_SPLASH = getSettings().reduceMotion || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function Shell() {
  const loc = useLocation();
  const s = useSettings();
  const { user, guest } = useAuth();
  const inApp = !!user || !!guest;
  const watching = loc.pathname.startsWith("/watch/");
  const main = useRef<HTMLElement>(null);
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [loc.pathname]);

  useEffect(() => {
    if (!inApp) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inApp]);

  return (
    <div className={`app ${watching ? "is-watching" : ""} ${s.reduceMotion ? "reduce-motion" : ""}`}>
      <div className="light" aria-hidden />
      <div className="grain" aria-hidden />
      <Splash skip={SKIP_SPLASH} />
      {!inApp ? (
        <Auth />
      ) : (
        <>
          {!watching && <TitleBar onOpenPalette={() => setPalette(true)} />}
          {!watching && <Rail />}
          <main ref={main} className="main">
            <Outlet />
          </main>
          <CommandPalette open={palette} onClose={() => setPalette(false)} />
          {!watching && <UpdateToast />}
          {!watching && <WhatsNew />}
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
      { path: "/movies", element: <Browse key="movie" kind="movie" /> },
      { path: "/series", element: <Browse key="tv" kind="tv" /> },
      { path: "/anime", element: <Anime /> },
      { path: "/list", element: <MyList /> },
      { path: "/library", element: <Library /> },
      { path: "/history", element: <History /> },
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

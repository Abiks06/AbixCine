import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { createHashRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { CommandPalette } from "./components/CommandPalette";
import { Splash } from "./components/Splash";
import { TopBar } from "./components/TopBar";
import { bootAccount, useAuth } from "./lib/account";
import { getSettings, useSettings } from "./lib/settings";
import { Auth } from "./pages/Auth";
import { Anime, Browse } from "./pages/Browse";
import { Home } from "./pages/Home";
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
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [loc.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`app ${watching ? "is-watching" : ""} ${s.reduceMotion ? "reduce-motion" : ""}`}>
      <Splash skip={SKIP_SPLASH} />
      {!user ? (
        <Auth />
      ) : (
        <>
          {!watching && <TopBar onOpenPalette={() => setPalette(true)} scrolled={scrolled} />}
          <main ref={main} className="main" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 40)}>
            <Outlet />
          </main>
          <CommandPalette open={palette} onClose={() => setPalette(false)} />
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
      { path: "/search", element: <Search /> },
      { path: "/settings", element: <Settings /> },
      { path: "/title/:key", element: <Title /> },
      {
        path: "/watch/:key",
        element: (
          <Suspense fallback={<div className="resolver"><span className="mini-spin" /></div>}>
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

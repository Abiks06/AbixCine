import { useLayoutEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Icon } from "./Icon";

const NAV = [
  { to: "/", label: "Home", icon: "home" },
  { to: "/movies", label: "Films", icon: "film" },
  { to: "/series", label: "Series", icon: "tv" },
  { to: "/anime", label: "Anime", icon: "spark" },
  { to: "/library", label: "Your drive", icon: "drive" },
  { to: "/list", label: "My List", icon: "bookmark" },
];

/** Floating glass rail. A lit pill springs to the active section; labels slide out on hover. */
export function Rail() {
  const loc = useLocation();
  const ref = useRef<HTMLElement>(null);
  const [y, setY] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>("a.active");
    setY(el ? el.offsetTop : null);
  }, [loc.pathname]);

  return (
    <nav className="rail" ref={ref} aria-label="Sections">
      <span className="pill" style={{ transform: `translateY(${(y ?? 6) - 6}px)`, opacity: y == null ? 0 : 1 }} />
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.to === "/"} aria-label={n.label} viewTransition>
          <Icon name={n.icon} size={20} />
          <span className="tip">{n.label}</span>
        </NavLink>
      ))}
      <hr />
      <NavLink to="/settings" aria-label="Settings" viewTransition>
        <Icon name="gear" size={20} />
        <span className="tip">Settings</span>
      </NavLink>
    </nav>
  );
}

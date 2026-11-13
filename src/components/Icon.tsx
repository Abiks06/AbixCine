const P: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  film: "M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4",
  tv: "M3 6h18v12H3zM8 21h8M12 18v3",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  play: "M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z",
  pause: "M6 4h4v16H6zM14 4h4v16h-4z",
  info: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 16v-4M12 8h.01",
  back: "M15 18l-6-6 6-6",
  chevR: "M9 6l6 6-6 6",
  chevL: "M15 6l-6 6 6 6",
  star: "M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z",
  vol: "M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11",
  mute: "M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6",
  full: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  unfull: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
  next: "M5 5l10 7-10 7zM17.5 5H20v14h-2.5z",
  rew: "M11 18V6l-8.5 6zM21 18V6l-8.5 6z",
  fwd: "M13 6v12l8.5-6zM3 6v12l8.5-6z",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5",
  x: "M6 6l12 12M18 6L6 18",
  min: "M5 12h14",
  max: "M5 5h14v14H5z",
  folder: "M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
  check: "M5 12l5 5 9-10",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  bookmark: "M6 3h12v18l-6-4-6 4z",
  bookmarkOn: "M6 3h12v18l-6-4-6 4z",
  plus: "M12 5v14M5 12h14",
  logout: "M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  mail: "M3 5h18v14H3zM3 6l9 7 9-7",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  arrowR: "M5 12h14M13 6l6 6-6 6",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  arrowUR: "M7 17L17 7M8 7h9v9",
  replay10: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5",
  fwd10: "M21 12a9 9 0 1 1-3-6.7M21 4v5h-5",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  drive: "M3 13h18v7H3zM5 13l2.5-8h9L19 13M7 16.5h.01",
  refresh: "M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4",
  hd: "M3 5h18v14H3zM7 9v6M7 12h4M11 9v6M14 9v6h2a3 3 0 0 0 0-6z",
  cc: "M3 5h18v14H3zM10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3",
  subtitles: "M3 5h18v14H3zM7 11.5h6M15 11.5h2M7 15h3M12 15h5",
  dual: "M3 5h14v9H3zM17 10h4v9H7v-5",
  download: "M12 3v12M7 10l5 5 5-5M5 19h14",
  upload: "M12 15V4M7 9l5-5 5 5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2",
  sliders: "M4 7h10M18 7h2M14 5v4M4 12h4M12 12h8M8 10v4M4 17h11M19 17h1M15 15v4",
  pip: "M3 5h18v14H3zM12 12h6v4h-6z",
  keys: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
};

const FILLED = new Set(["play", "pause", "star", "next", "rew", "fwd", "bookmarkOn"]);

export function Icon({ name, size = 18, className }: { name: keyof typeof P | string; size?: number; className?: string }) {
  const filled = FILLED.has(name);
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={P[name]} />
    </svg>
  );
}

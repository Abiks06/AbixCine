import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { encodeKey } from "../lib/catalog";
import { openDossier, registerMedia } from "../lib/dossier";
import { fmtSize, qualityBadge, sortDriveGroups, useDrive, type DriveSort, type DriveTitle } from "../lib/library";
import { previewLight } from "../lib/light";
import { useSettings } from "../lib/settings";
import { Art } from "./Art";
import { Icon } from "./Icon";
import { SectionHead } from "./SectionHead";
import { folderLabel } from "./TitleBar";

const ago = (t?: number) => {
  if (!t) return "";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

export function DriveTile({ t, i = 0 }: { t: DriveTitle; i?: number }) {
  const name = t.isShow
    ? `${t.title}${t.season ? ` S${t.season}` : ""} (${t.files.length} file${t.files.length > 1 ? "s" : ""})`
    : `${t.title}${t.year ? ` (${t.year})` : ""}`;
  const meta = [t.quality ? `${t.quality}p` : null, t.hdr, fmtSize(t.size), t.dual ? "Dual audio" : t.audio].filter(Boolean).join(" · ");
  const matchedMedia = t.media;
  if (matchedMedia) registerMedia(matchedMedia);

  const body = (
    <>
      <div className="th">
        {t.media ? <Art media={t.media} size="sm" /> : <div className="th-blank"><Icon name="film" size={20} /></div>}
      </div>
      <div className="file-body">
        <div className="t">{name}</div>
        <div className="m">{meta}</div>
        <div className="file-tags">
          <span className={`q ${qualityBadge(t.quality) === "4K" ? "" : "hd"}`}>{qualityBadge(t.quality)}</span>
          <span className="badge">LOCAL</span>
          {!t.media && <span className="badge dim">UNMATCHED</span>}
        </div>
      </div>
    </>
  );

  return matchedMedia ? (
    <div
      className="file-slot"
      data-media-key={matchedMedia.key}
      onMouseEnter={() => previewLight(matchedMedia)}
      onMouseLeave={() => previewLight(null)}
    >
      <Link
        to={`/title/${encodeKey(matchedMedia.key)}`}
        className="file"
        style={{ ["--i" as any]: Math.min(i, 10) }}
        state={{ seed: matchedMedia }}
        viewTransition
      >
        {body}
      </Link>
      <button
        type="button"
        className="file-pass"
        title="Quick screening pass"
        aria-label={`Quick inspect ${matchedMedia.title}`}
        onClick={() => openDossier(matchedMedia)}
      >
        <Icon name="layers" size={13} />
      </button>
    </div>
  ) : (
    <div className="file" style={{ ["--i" as any]: Math.min(i, 10) }} title="AbixCine couldn't match this file to a title yet. Renaming it to “Title (Year)” helps.">
      {body}
    </div>
  );
}

/** Physical Media Vault: local drives & matched master files playing instantly with zero network latency. */
export function DriveSection({ limit, rescan = 0, bare = false }: { limit?: number; rescan?: number; bare?: boolean }) {
  const s = useSettings();
  const drive = useDrive(rescan);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "movie" | "show">("all");
  const [sortBy, setSortBy] = useState<DriveSort>("title");

  const where = s.libraryPaths.length === 1 ? folderLabel(s.libraryPaths[0]) : s.libraryPaths.length ? `${s.libraryPaths.length} folders` : "your drive";

  const filtered = useMemo(() => {
    if (limit) return drive.titles;
    const q = query.trim().toLowerCase();
    const matched = drive.titles.filter((t) => {
      if (kindFilter === "movie" && t.isShow) return false;
      if (kindFilter === "show" && !t.isShow) return false;
      if (q && !t.title.toLowerCase().includes(q) && !String(t.year ?? "").includes(q)) return false;
      return true;
    });
    return sortDriveGroups(matched, sortBy);
  }, [drive.titles, limit, query, kindFilter, sortBy]);

  const shown = limit ? filtered.slice(0, limit) : filtered;
  const showToolbar = !limit && drive.titles.length > 0;

  return (
    <section className="shelf vault-bay" id="drive">
      {bare ? (
        drive.files ? <p className="shelf-note drive-note">LOCAL FIRST · ZERO LATENCY · {drive.files.toLocaleString()} FILES · SCANNED {ago(drive.at)}</p> : null
      ) : (
        <SectionHead
          eyebrow="Local first · zero latency · plays offline"
          title="Vault:"
          accentWord={where}
          to={limit && drive.titles.length > limit ? "/library" : undefined}
          right={drive.files ? <span className="shelf-note">{drive.files.toLocaleString()} FILES · {ago(drive.at)}</span> : null}
        />
      )}
      {s.libraryPaths.length === 0 && bare ? (
        <div className="empty">
          <span className="empty-ic"><Icon name="folder" size={26} /></span>
          <h3>No folders yet</h3>
          <p>Point AbixCine at the films and shows already on this PC. They're matched to the catalog automatically and play first, before any server, with no internet needed.</p>
          <Link to="/settings#sources" className="btn play sm" viewTransition><Icon name="plus" size={16} /> Add a media folder</Link>
        </div>
      ) : s.libraryPaths.length === 0 ? (
        <Link to="/settings#sources" className="drive-empty" viewTransition>
          <span className="drive-empty-ic"><Icon name="folder" size={22} /></span>
          <div>
            <strong>Mount a local media vault</strong>
            <span>Point AbixCine at movies and series stored on this PC. Local files play first with zero latency.</span>
          </div>
          <Icon name="arrowR" size={16} />
        </Link>
      ) : drive.loading && !drive.titles.length ? (
        <div className="drive">{Array.from({ length: limit ?? 6 }, (_, i) => <div key={i} className="file skeleton" />)}</div>
      ) : drive.error || (drive.warning && !drive.titles.length) ? (
        <p className="muted">Couldn't scan: {drive.error ?? drive.warning}</p>
      ) : drive.titles.length === 0 ? (
        <p className="muted drive-note">No video files found in {where} yet. Names like “Movie (2021).mkv” or “Show S01E02.mp4” are picked up on the next scan.</p>
      ) : (
        <>
          {showToolbar && (
            <div className="dlv-toolbar drive-toolbar">
              <div className="dlv-search">
                <Icon name="search" size={14} />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter local titles…"
                  aria-label="Filter local files"
                />
              </div>
              <div className="dlv-filters" role="tablist" aria-label="Filter local files by kind">
                {(
                  [
                    ["all", "All"],
                    ["movie", "Films"],
                    ["show", "Series"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={kindFilter === id}
                    className={`chip ${kindFilter === id ? "on" : ""}`}
                    onClick={() => setKindFilter(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <select
                className="ep-q-pick dlv-sort"
                aria-label="Sort local library"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as DriveSort)}
              >
                <option value="title">Title A–Z</option>
                <option value="count">Most files</option>
                <option value="size">Largest</option>
              </select>
            </div>
          )}
          {shown.length === 0 ? (
            <p className="muted drive-note">No local titles match “{query}”.</p>
          ) : (
            <div className="drive">{shown.map((t, i) => <DriveTile key={t.id} t={t} i={i} />)}</div>
          )}
        </>
      )}
    </section>
  );
}

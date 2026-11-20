import { isTauri } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { encodeKey } from "../lib/catalog";
import {
  ensureDownloadFolder,
  groupDownloadedTitles,
  openDownloadsFolder,
  removeDownloadedItem,
  useDownloads,
  type DownloadedTitleGroup,
} from "../lib/downloads";
import { fmtSize, qualityBadge } from "../lib/library";
import { useOnlineStatus } from "../lib/online";
import { useSettings } from "../lib/settings";
import { Art } from "./Art";
import { Icon } from "./Icon";
import { SectionHead } from "./SectionHead";

type KindFilter = "all" | "movie" | "tv" | "anime";

function playTargetUrl(g: DownloadedTitleGroup, ep?: DownloadedTitleGroup["entries"][number]): string {
  const chosen = ep ?? g.entries[0];
  const base = `/watch/${encodeKey(chosen?.mediaKey || g.canonicalKey)}`;
  const params = new URLSearchParams();
  if (!g.isFilm && chosen) {
    if (chosen.season != null) params.set("s", String(chosen.season));
    if (chosen.episode != null) params.set("e", String(chosen.episode));
  }
  if (chosen?.audio && chosen.audio !== "dual" && chosen.audio !== "unknown") {
    params.set("a", chosen.audio);
  }
  const q = params.toString();
  return q ? `${base}?${q}` : base;
}

/**
 * Dedicated Offline Downloads Vault:
 * Renders auto-sorted offline films, series, and anime with local artwork, direct offline play links,
 * expandable episode trays, and safe deletion with disk cleanup.
 */
export function DownloadsVault({
  compact = false,
  limit,
  showSetupWhenEmpty = false,
}: {
  compact?: boolean;
  limit?: number;
  showSetupWhenEmpty?: boolean;
}) {
  const desktop = isTauri();
  const s = useSettings();
  const online = useOnlineStatus();
  const { items, root } = useDownloads();
  const nav = useNavigate();

  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmGroup, setConfirmGroup] = useState<string | null>(null);
  const [confirmEntry, setConfirmEntry] = useState<string | null>(null);

  const groups = useMemo(() => groupDownloadedTitles(items), [items]);
  const filtered = useMemo(() => {
    if (kindFilter === "all") return groups;
    return groups.filter((g) => g.media.kind === kindFilter);
  }, [groups, kindFilter]);

  if (!desktop) return null;

  if (groups.length === 0) {
    if (!showSetupWhenEmpty) return null;
    return (
      <section className="shelf dlv-section" id="downloads-vault">
        <div className="dlv-setup glass">
          <span className="drive-empty-ic" aria-hidden>
            <Icon name="download" size={22} />
          </span>
          <div className="dlv-setup-copy">
            <strong>{s.downloadsPath ? "Downloads vault ready" : "Set up your Offline Downloads Vault"}</strong>
            <span>
              {s.downloadsPath
                ? `Saved films and episodes will auto-sort under ${s.downloadsPath} into Movies, Series, and Anime folders.`
                : "Download episodes or movies from any downloadable server—automatically sorted into subfolders and played first offline."}
            </span>
          </div>
          {s.downloadsPath ? (
            <button type="button" className="btn glass sm" onClick={() => void openDownloadsFolder(s.downloadsPath)}>
              <Icon name="folder" size={15} /> Open folder
            </button>
          ) : (
            <button type="button" className="btn play sm" onClick={() => void ensureDownloadFolder()}>
              <Icon name="folder" size={15} /> Choose folder
            </button>
          )}
        </div>
      </section>
    );
  }

  const totalBytes = items.reduce((sum, e) => sum + (e.fileSize || 0), 0);
  const shown = limit ? filtered.slice(0, limit) : filtered;
  const presentKinds = new Set(groups.map((g) => g.media.kind));

  const deleteGroup = async (g: DownloadedTitleGroup) => {
    for (const entry of g.entries) {
      await removeDownloadedItem(entry.id, true);
    }
    setConfirmGroup(null);
    if (expanded === g.canonicalKey) setExpanded(null);
  };

  return (
    <section className={`shelf dlv-section ${compact ? "compact" : ""}`} id="downloads-vault">
      <SectionHead
        eyebrow={online ? "Saved offline · Auto-sorted local server" : "Offline mode · Ready to watch right now"}
        title="Downloads"
        accentWord={compact && !online ? "ready offline" : "vault"}
        to={compact && groups.length > (limit ?? 0) ? "/library" : undefined}
        right={
          <div className="dlv-head-acts">
            <span className="shelf-note">
              {groups.length} {groups.length === 1 ? "TITLE" : "TITLES"} · {items.length}{" "}
              {items.length === 1 ? "FILE" : "FILES"} · {fmtSize(totalBytes)}
            </span>
            {!compact && root && (
              <button
                type="button"
                className="btn glass sm"
                onClick={() => void openDownloadsFolder(root)}
                title={root}
              >
                <Icon name="folder" size={14} /> Open folder
              </button>
            )}
          </div>
        }
      />

      {!compact && presentKinds.size > 1 && (
        <div className="dlv-filters" role="tablist" aria-label="Filter downloads by type">
          {([
            ["all", "All", groups.length],
            ["movie", "Films", groups.filter((g) => g.media.kind === "movie").length],
            ["tv", "Series", groups.filter((g) => g.media.kind === "tv").length],
            ["anime", "Anime", groups.filter((g) => g.media.kind === "anime").length],
          ] as const)
            .filter(([id, , count]) => id === "all" || count > 0)
            .map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={kindFilter === id}
                className={`chip ${kindFilter === id ? "on" : ""}`}
                onClick={() => setKindFilter(id)}
              >
                {label} · {count}
              </button>
            ))}
        </div>
      )}

      <div className="dlv-grid">
        {shown.map((g) => {
          const isExp = expanded === g.canonicalKey;
          const isConfirm = confirmGroup === g.canonicalKey;
          const qBadge = qualityBadge(g.bestQuality);
          const summaryMeta = [
            g.isFilm ? "Film" : `${g.entries.length} episode${g.entries.length === 1 ? "" : "s"}`,
            g.media.year,
            fmtSize(g.totalSize),
          ]
            .filter(Boolean)
            .join(" · ");

          return (
            <article key={g.canonicalKey} className={`dlv-card ${isExp ? "open" : ""}`}>
              <div className="dlv-top">
                <Link
                  to={`/title/${encodeKey(g.canonicalKey)}`}
                  state={{ seed: g.media }}
                  viewTransition
                  className="dlv-poster"
                  aria-label={`Open ${g.media.title}`}
                >
                  <Art media={g.media} variant="poster" size="sm" />
                </Link>

                <div className="dlv-info">
                  <Link
                    to={`/title/${encodeKey(g.canonicalKey)}`}
                    state={{ seed: g.media }}
                    viewTransition
                    className="dlv-title"
                  >
                    {g.media.title}
                  </Link>
                  <div className="dlv-meta">{summaryMeta}</div>
                  <div className="dlv-badges">
                    <span className="badge offline">OFFLINE</span>
                    {g.bestQuality && <span className={`q ${qBadge === "4K" ? "" : "hd"}`}>{qBadge}</span>}
                    {g.audioTags.map((a) => (
                      <span key={a} className="badge dim">
                        {a.toUpperCase()}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="dlv-acts">
                  <button
                    type="button"
                    className="btn play sm"
                    onClick={() => nav(playTargetUrl(g), { viewTransition: true, state: { from: "app" } })}
                    title={
                      g.isFilm
                        ? `Play ${g.media.title}`
                        : `Play S${g.entries[0]?.season ?? 1} E${g.entries[0]?.episode ?? 1}`
                    }
                  >
                    <Icon name="play" size={14} />
                    <span>
                      {g.isFilm ? "Play" : `Play E${g.entries[0]?.episode ?? 1}`}
                    </span>
                  </button>

                  {!compact && !g.isFilm && (
                    <button
                      type="button"
                      className={`btn glass sm ${isExp ? "on" : ""}`}
                      aria-expanded={isExp}
                      onClick={() => {
                        setConfirmGroup(null);
                        setExpanded(isExp ? null : g.canonicalKey);
                      }}
                    >
                      <Icon name="rows" size={14} />
                      <span>{g.entries.length}</span>
                    </button>
                  )}

                  {!compact &&
                    (isConfirm ? (
                      <div className="dlv-confirm">
                        <button
                          type="button"
                          className="chip danger"
                          onClick={() => void deleteGroup(g)}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          className="chip"
                          onClick={() => setConfirmGroup(null)}
                        >
                          Keep
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Delete downloaded files for ${g.media.title}`}
                        title="Delete from Downloads vault"
                        onClick={() => setConfirmGroup(g.canonicalKey)}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    ))}
                </div>
              </div>

              {!compact && isExp && (
                <div className="dlv-eps">
                  {g.entries.map((e) => {
                    const epConfirm = confirmEntry === e.id;
                    const code = `S${String(e.season ?? 1).padStart(2, "0")}E${String(e.episode ?? 1).padStart(2, "0")}`;
                    return (
                      <div key={e.id} className="dlv-ep">
                        <div className="dlv-ep-main">
                          <b>{code}</b>
                          <span>{e.episodeTitle || `Episode ${e.episode ?? 1}`}</span>
                          <small>
                            {[e.quality ? `${e.quality}p` : null, e.audio?.toUpperCase(), fmtSize(e.fileSize), e.providerName]
                              .filter(Boolean)
                              .join(" · ")}
                          </small>
                        </div>
                        <div className="dlv-ep-acts">
                          <button
                            type="button"
                            className="chip"
                            onClick={() => nav(playTargetUrl(g, e), { viewTransition: true, state: { from: "app" } })}
                          >
                            <Icon name="play" size={11} /> Play
                          </button>
                          {epConfirm ? (
                            <>
                              <button
                                type="button"
                                className="chip danger"
                                onClick={() => {
                                  setConfirmEntry(null);
                                  void removeDownloadedItem(e.id, true);
                                }}
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                className="chip"
                                onClick={() => setConfirmEntry(null)}
                              >
                                Keep
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="icon-btn"
                              aria-label={`Delete ${code}`}
                              title="Delete episode file"
                              onClick={() => setConfirmEntry(e.id)}
                            >
                              <Icon name="x" size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

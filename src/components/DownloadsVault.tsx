import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useBatchDownloads } from "../lib/batchDownload";
import { encodeKey } from "../lib/catalog";
import {
  cancelAllDownloads,
  cancelDownload,
  clearFailedDownloads,
  ensureDownloadFolder,
  fetchMissingDownloadSubtitles,
  fmtEta,
  fmtSpeed,
  formatDownloadQuality,
  formatQualityTag,
  groupDownloadedTitles,
  openDownloadsFolder,
  pauseAllDownloads,
  pauseDownload,
  refreshDownloads,
  removeDownloadedItem,
  resumeAllDownloads,
  resumeDownload,
  switchDownloadToNextServer,
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
  const { jobs, items, root, switchingIds } = useDownloads();
  const batch = useBatchDownloads();
  const nav = useNavigate();

  useEffect(() => {
    if (desktop && root) void refreshDownloads({ minIntervalMs: 1500 });
  }, [desktop, root]);

  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmGroup, setConfirmGroup] = useState<string | null>(null);
  const [confirmEntry, setConfirmEntry] = useState<string | null>(null);
  const [confirmStopAll, setConfirmStopAll] = useState(false);
  const [fetchingSubId, setFetchingSubId] = useState<string | null>(null);

  const handleFetchSubs = async (entry: DownloadedTitleGroup["entries"][number]) => {
    if (fetchingSubId) return;
    setFetchingSubId(entry.id);
    try {
      await fetchMissingDownloadSubtitles(entry);
    } finally {
      setFetchingSubId((cur) => (cur === entry.id ? null : cur));
    }
  };

  const liveJobs = useMemo(
    () =>
      jobs.filter(
        (j) =>
          j.status === "queued" ||
          j.status === "downloading" ||
          j.status === "remuxing" ||
          j.status === "paused" ||
          j.status === "failed",
      ),
    [jobs],
  );
  const activeCount = liveJobs.filter(
    (j) => j.status === "queued" || j.status === "downloading" || j.status === "remuxing",
  ).length;
  const pausedCount = liveJobs.filter((j) => j.status === "paused").length;
  const failedCount = liveJobs.filter((j) => j.status === "failed").length;

  const groups = useMemo(() => groupDownloadedTitles(items), [items]);
  const filtered = useMemo(() => {
    if (kindFilter === "all") return groups;
    return groups.filter((g) => g.media.kind === kindFilter);
  }, [groups, kindFilter]);

  if (!desktop) return null;

  if (groups.length === 0 && (compact || (liveJobs.length === 0 && !batch.active))) {
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

      {!compact && (liveJobs.length > 0 || batch.active) && (
        <div className="dlv-queue glass" aria-label="Active and failed transfers">
          <div className="dlv-queue-head">
            <span>
              TRANSFERS · {liveJobs.length}
              {failedCount > 0 ? ` (${failedCount} FAILED)` : ""}
            </span>
            <div className="dlv-queue-acts">
              {activeCount > 0 && (
                <button type="button" className="chip" onClick={() => void pauseAllDownloads()}>
                  <Icon name="pause" size={11} /> Pause all
                </button>
              )}
              {(pausedCount > 0 || failedCount > 0) && (
                <button type="button" className="chip" onClick={() => void resumeAllDownloads()}>
                  <Icon name="play" size={11} /> Resume all
                </button>
              )}
              {failedCount > 0 && (
                <button type="button" className="chip" onClick={() => void clearFailedDownloads()}>
                  Clear failed
                </button>
              )}
              {confirmStopAll && liveJobs.length > 1 ? (
                <>
                  <button
                    type="button"
                    className="chip danger"
                    onClick={() => {
                      setConfirmStopAll(false);
                      void cancelAllDownloads();
                    }}
                  >
                    Stop all ({liveJobs.length})
                  </button>
                  <button type="button" className="chip" onClick={() => setConfirmStopAll(false)}>
                    Keep
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="chip danger"
                  onClick={() => {
                    if (liveJobs.length > 1) setConfirmStopAll(true);
                    else void cancelAllDownloads();
                  }}
                >
                  <Icon name="x" size={11} /> Stop &amp; clear all
                </button>
              )}
            </div>
          </div>
          {batch.active && (
            <div className="dlq-batch">
              <div>
                <strong>Finding streams · {batch.title}</strong>
                <small>
                  {batch.season != null ? `Season ${batch.season} · ` : ""}
                  E{batch.currentEp ?? "…"} · {batch.queued}/{batch.total} queued
                </small>
              </div>
              <button
                type="button"
                className="chip danger"
                onClick={() => void cancelAllDownloads({ canonicalKey: batch.canonicalKey, season: batch.season })}
              >
                Stop
              </button>
            </div>
          )}
          {(() => {
            const seasonGroups = new Map<string, { title: string; cKey: string; season: number; jobs: typeof liveJobs }>();
            for (const j of liveJobs) {
              if (j.isFilm || j.episode == null) continue;
              const cKey = j.canonicalKey || j.mediaKey;
              const sNum = j.season ?? 1;
              const gKey = `${cKey}|${sNum}`;
              const g = seasonGroups.get(gKey);
              if (g) g.jobs.push(j);
              else seasonGroups.set(gKey, { title: j.title, cKey, season: sNum, jobs: [j] });
            }
            for (const bs of Object.values(batch.seasons)) {
              const gKey = `${bs.canonicalKey}|${bs.season}`;
              if (!seasonGroups.has(gKey)) {
                seasonGroups.set(gKey, { title: bs.title, cKey: bs.canonicalKey, season: bs.season, jobs: [] });
              }
            }
            const shownSeasons = [...seasonGroups.values()].filter((g) => {
              const bs = batch.seasons[`${g.cKey}|${g.season}`];
              const savedCount = items.filter(
                (it) => !it.isFilm && (it.canonicalKey === g.cKey || it.mediaKey === g.cKey) && (it.season ?? 1) === g.season,
              ).length;
              return Boolean(bs) || g.jobs.length > 1 || (savedCount > 0 && g.jobs.length >= 1);
            });
            if (!shownSeasons.length) return null;
            return (
              <div className="dlv-seasons" aria-label="Bulk season downloads">
                {shownSeasons.map((g) => {
                  const bs = batch.seasons[`${g.cKey}|${g.season}`];
                  const savedCount = items.filter(
                    (it) => !it.isFilm && (it.canonicalKey === g.cKey || it.mediaKey === g.cKey) && (it.season ?? 1) === g.season,
                  ).length;
                  const totalCount = bs ? Math.max(bs.total, savedCount + g.jobs.length) : savedCount + g.jobs.length;
                  const frac =
                    savedCount + g.jobs.reduce((acc, j) => acc + (j.status === "failed" ? 0 : (j.percent || 0) / 100), 0);
                  const pct = totalCount > 0 ? Math.min(100, Math.round((frac / totalCount) * 100)) : 0;
                  const activeInS = g.jobs.filter(
                    (j) => j.status === "queued" || j.status === "downloading" || j.status === "remuxing",
                  );
                  const pausedOrFailedInS = g.jobs.filter((j) => j.status === "paused" || j.status === "failed");
                  const spd = fmtSpeed(activeInS.reduce((s, j) => s + (j.speedBps || 0), 0));
                  return (
                    <div key={`${g.cKey}|${g.season}`} className="dlv-season-row">
                      <div className="dlv-sr-main">
                        <div className="dlv-sr-top">
                          <strong>{g.title} · Season {g.season}</strong>
                          <small>
                            {savedCount}/{totalCount} offline
                            {bs ? ` · resolving (${bs.queued}/${bs.total})` : ""}
                            {activeInS.length > 0 ? ` · ${activeInS.length} active` : ""}
                            {pausedOrFailedInS.length > 0 ? ` · ${pausedOrFailedInS.length} paused/failed` : ""}
                            {spd ? ` · ${spd}` : ""}
                          </small>
                          <b>{pct}%</b>
                        </div>
                        <div className="dl-bar">
                          <i style={{ transform: `scaleX(${Math.max(0.02, pct / 100)})` }} />
                        </div>
                      </div>
                      <div className="dlv-sr-acts">
                        {activeInS.length > 0 && (
                          <button
                            type="button"
                            className="chip"
                            onClick={() => void pauseAllDownloads({ canonicalKey: g.cKey, season: g.season })}
                          >
                            <Icon name="pause" size={11} /> Pause S{g.season}
                          </button>
                        )}
                        {pausedOrFailedInS.length > 0 && (
                          <button
                            type="button"
                            className="chip"
                            onClick={() => void resumeAllDownloads({ canonicalKey: g.cKey, season: g.season })}
                          >
                            <Icon name="play" size={11} /> Resume S{g.season}
                          </button>
                        )}
                        <button
                          type="button"
                          className="chip danger"
                          onClick={() => void cancelAllDownloads({ canonicalKey: g.cKey, season: g.season })}
                          title={`Stop & clear Season ${g.season} downloads`}
                        >
                          <Icon name="x" size={11} /> Cancel S{g.season}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <div className="dlv-queue-list">
            {liveJobs.map((j) => {
              const busy = j.status === "queued" || j.status === "downloading" || j.status === "remuxing";
              const qInfo = formatDownloadQuality(j);
              const isSwitching = switchingIds.has(j.id);
              const epTag =
                !j.isFilm && j.episode != null
                  ? `S${String(j.season ?? 1).padStart(2, "0")}E${String(j.episode).padStart(2, "0")}`
                  : null;
              const spd = fmtSpeed(j.speedBps);
              const eta = fmtEta(j.etaSec);
              const sizeStr =
                j.bytesDownloaded > 0
                  ? j.totalBytes
                    ? `${fmtSize(j.bytesDownloaded)} / ${fmtSize(j.totalBytes)}`
                    : fmtSize(j.bytesDownloaded)
                  : null;
              return (
                <div key={j.id} className={`dlv-qrow ${j.status}`}>
                  <div className="dlq-main">
                    <div className="dlq-title">
                      <strong>{j.title}</strong>
                      {epTag && <span className="badge dim">{epTag}</span>}
                      <b className="dlq-pct">{Math.round(j.percent)}%</b>
                    </div>
                    <div className="dlq-badges">
                      {qInfo.label && (
                        <span className={`dlq-badge-q ${qInfo.verified ? "verified" : ""}`} title={qInfo.title}>
                          {qInfo.label}
                          {qInfo.verified ? " ✓" : ""}
                        </span>
                      )}
                      {j.videoCodec && <span className="dlq-badge-dim">{j.videoCodec}</span>}
                      <span className="dlq-badge-dim">{j.kind === "hls" ? "HLS→MP4" : "DIRECT"}</span>
                      {((j.attemptIndex ?? 1) > 1 || (j.totalSources ?? 1) > 1) && (
                        <span className="dlq-badge-dim">
                          Server {j.attemptIndex ?? 1}/{Math.max(j.attemptIndex ?? 1, j.totalSources ?? 1)}
                        </span>
                      )}
                    </div>
                    <small>
                      {[
                        j.providerName,
                        j.error || j.stage || j.status,
                        j.segmentsDone != null && j.segmentsTotal ? `${j.segmentsDone}/${j.segmentsTotal} segs` : null,
                        sizeStr,
                        spd || null,
                        eta ? `${eta} left` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                    {j.failoverNotes && j.failoverNotes.length > 0 && (
                      <span className="dlq-fail-note">
                        Switched after: {j.failoverNotes[j.failoverNotes.length - 1]}
                      </span>
                    )}
                    <div className="dl-bar">
                      <i style={{ transform: `scaleX(${Math.max(0.02, j.percent / 100)})` }} />
                    </div>
                  </div>
                  <div className="dlq-acts">
                    {busy ? (
                      <button
                        type="button"
                        className="chip"
                        disabled={j.status === "remuxing"}
                        onClick={() => void pauseDownload(j.id)}
                      >
                        <Icon name="pause" size={11} /> Pause
                      </button>
                    ) : (
                      <button type="button" className="chip" onClick={() => void resumeDownload(j.id)}>
                        <Icon name={j.status === "failed" ? "refresh" : "play"} size={11} />{" "}
                        {j.status === "failed" ? "Retry" : "Resume"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="chip"
                      disabled={j.status === "remuxing" || isSwitching}
                      onClick={() => void switchDownloadToNextServer(j)}
                      title="Switch to another server"
                    >
                      <Icon name="shuffle" size={11} /> {isSwitching ? "Finding…" : "Try another server"}
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Cancel ${j.title}`}
                      onClick={() => void cancelDownload(j.id)}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
                  {!g.isFilm && (() => {
                    const primaryS = g.entries[0]?.season ?? 1;
                    const seasonObj = g.media.seasons?.find((sn) => sn.number === primaryS);
                    const totalInSeason =
                      seasonObj?.episodeCount ??
                      (primaryS === 1 ? (g.media.episodeCount ?? g.media.totalEpisodes) : undefined);
                    if (!totalInSeason || totalInSeason <= 0) return null;
                    const savedInSeason = g.entries.filter((e) => (e.season ?? 1) === primaryS).length;
                    const sPct = Math.min(100, Math.round((savedInSeason / totalInSeason) * 100));
                    return (
                      <div className="dlv-season-bar" title={`Season ${primaryS}: ${savedInSeason} of ${totalInSeason} episodes saved offline`}>
                        <span>S{String(primaryS).padStart(2, "0")} · {savedInSeason}/{totalInSeason} ep ({sPct}%)</span>
                        <div className="dl-bar"><i style={{ transform: `scaleX(${Math.max(0.03, sPct / 100)})` }} /></div>
                      </div>
                    );
                  })()}
                  <div className="dlv-badges">
                    <span className="badge offline">OFFLINE</span>
                    {g.bestQuality && (
                      <span
                        className={`q ${qBadge === "4K" ? "" : "hd"}`}
                        title={g.entries.some((e) => e.qualityVerified) ? "Verified via FFprobe" : undefined}
                      >
                        {qBadge}
                        {g.entries.some((e) => e.qualityVerified) ? " ✓" : ""}
                      </span>
                    )}
                    {g.entries[0]?.videoCodec && (
                      <span className="badge dim">{g.entries[0].videoCodec}</span>
                    )}
                    {g.audioTags.map((a) => (
                      <span key={a} className="badge dim">
                        {a.toUpperCase()}
                      </span>
                    ))}
                    {g.entries.some((e) => (e.subtitlePaths?.length ?? 0) > 0) && (
                      <span className="badge dim" title="Offline subtitles saved">
                        SUBS
                      </span>
                    )}
                  </div>
                </div>

                <div className="dlv-acts">
                  <button
                    type="button"
                    className="btn play sm"
                    onClick={() =>
                      nav(playTargetUrl(g), { viewTransition: true, state: { from: "app", offline: true, quick: true } })
                    }
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

                  {!compact && g.isFilm && online && g.entries[0] && !(g.entries[0].subtitlePaths?.length) && (
                    <button
                      type="button"
                      className="btn glass sm"
                      disabled={fetchingSubId === g.entries[0].id}
                      onClick={() => void handleFetchSubs(g.entries[0])}
                      title="Download offline subtitles for this film"
                    >
                      <Icon name="subtitles" size={14} />
                      <span>{fetchingSubId === g.entries[0].id ? "Fetching…" : "Get subs"}</span>
                    </button>
                  )}

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
                            {[
                              formatQualityTag(e.quality, e.qualityVerified),
                              e.videoCodec,
                              e.audio?.toUpperCase(),
                              fmtSize(e.fileSize),
                              e.providerName,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </small>
                        </div>
                        <div className="dlv-ep-acts">
                          {(e.subtitlePaths?.length ?? 0) > 0 ? (
                            <span className="badge dim" title="Offline subtitles saved">
                              SUBS
                            </span>
                          ) : online ? (
                            <button
                              type="button"
                              className="chip"
                              disabled={fetchingSubId === e.id}
                              onClick={() => void handleFetchSubs(e)}
                              title="Download offline subtitles for this episode"
                            >
                              <Icon name="subtitles" size={11} /> {fetchingSubId === e.id ? "Fetching…" : "Get subs"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="chip"
                            onClick={() =>
                              nav(playTargetUrl(g, e), {
                                viewTransition: true,
                                state: { from: "app", offline: true, quick: true },
                              })
                            }
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

import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useBatchDownloads } from "../lib/batchDownload";
import { encodeKey } from "../lib/catalog";
import { formatResolution } from "../lib/downloadRank";
import {
  cancelAllDownloads,
  cancelDownload,
  clearFailedDownloads,
  ensureDownloadFolder,
  entryContainer,
  fetchMissingDownloadSubtitles,
  fmtEta,
  fmtSpeed,
  formatDownloadQuality,
  formatDownloadTransferLabel,
  formatQualityTag,
  groupDownloadedTitles,
  openDownloadsFolder,
  organizeDownloadedVault,
  pauseAllDownloads,
  pauseDownload,
  refreshDownloads,
  removeDownloadedItem,
  resolveQualityMismatch,
  resumeAllDownloads,
  resumeDownload,
  sortDownloadedGroups,
  switchDownloadToNextServer,
  useDownloads,
  type DownloadedTitleGroup,
  type DownloadVaultSort,
} from "../lib/downloads";
import { fmtSize, qualityBadge } from "../lib/library";
import { useOnlineStatus } from "../lib/online";
import { isDone, isEpisodeWatched, getEpisodeProgress, getEpisodesMap, getResumePosition, markEpisodeWatched, restoreProgress, RESUME_MIN_SEC, useProgressStore } from "../lib/progress";
import { useSettings } from "../lib/settings";
import { toast } from "../lib/toast";
import { Art } from "./Art";
import { DownloadPrefsPill } from "./DownloadControl";
import { openQualityReviewModal } from "./DownloadQualityModal";
import { Icon } from "./Icon";
import { SectionHead } from "./SectionHead";

type KindFilter = "all" | "movie" | "tv" | "anime";
type FormatFilter = "all" | "mp4" | "mkv";

function pickPlayTarget(g: DownloadedTitleGroup): { entry: DownloadedTitleGroup["entries"][number] | undefined; resume: boolean; resumeSec?: number } {
  const aliasKeys = [g.media.key, ...g.entries.map((e) => e.mediaKey)];
  if (g.isFilm) {
    const first = g.entries[0];
    const ep = first ? getEpisodeProgress(g.canonicalKey, undefined, undefined, aliasKeys) : undefined;
    const resumeSec = first ? getResumePosition(g.canonicalKey, undefined, undefined, aliasKeys) : undefined;
    return { entry: first, resume: Boolean(resumeSec), resumeSec: resumeSec ?? (ep && !ep.completed && ep.position > RESUME_MIN_SEC ? ep.position : undefined) };
  }

  const map = getEpisodesMap(g.canonicalKey, aliasKeys);
  const entryByEp = g.entries.map((entry) => {
    const s = entry.season ?? 1;
    const e = entry.episode ?? 1;
    const ep = map[`s${s}:e${e}`] ?? (s === 1 ? map[`s0:e${e}`] : undefined);
    const watched = Boolean(ep && (ep.completed || isDone(ep.position, ep.duration)));
    const inProgress = Boolean(ep && !watched && ep.position > RESUME_MIN_SEC);
    return { entry, ep, watched, inProgress };
  });

  // 1. Most recently updated incomplete downloaded episode wins (so accidental E4 skip never loses E3!).
  const active = entryByEp
    .filter((x) => x.inProgress)
    .sort((a, b) => (b.ep?.updatedAt ?? 0) - (a.ep?.updatedAt ?? 0))[0];
  if (active) return { entry: active.entry, resume: true, resumeSec: active.ep?.position };

  // 2. First unwatched episode after the highest watched downloaded episode (or first unwatched overall).
  let lastWatchedIdx = -1;
  entryByEp.forEach((x, idx) => {
    if (x.watched) lastWatchedIdx = idx;
  });
  if (lastWatchedIdx >= 0 && lastWatchedIdx + 1 < entryByEp.length) {
    const nextUnwatched = entryByEp.slice(lastWatchedIdx + 1).find((x) => !x.watched);
    if (nextUnwatched) return { entry: nextUnwatched.entry, resume: false };
  }
  const firstUnwatched = entryByEp.find((x) => !x.watched);
  if (firstUnwatched) return { entry: firstUnwatched.entry, resume: false };

  return { entry: g.entries[0], resume: false };
}

function playTargetUrl(g: DownloadedTitleGroup, ep?: DownloadedTitleGroup["entries"][number]): string {
  const chosen = ep ?? g.entries[0];
  const base = `/watch/${encodeKey(g.canonicalKey || chosen?.mediaKey || g.media.key)}`;
  const params = new URLSearchParams();
  if (!g.isFilm && chosen) {
    if (chosen.season != null) params.set("s", String(chosen.season));
    if (chosen.episode != null) params.set("e", String(chosen.episode));
  }
  if (chosen?.audio && chosen.audio !== "dual" && chosen.audio !== "unknown") {
    params.set("a", chosen.audio);
  }
  params.set("srv", "downloads");
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
  useProgressStore();

  useEffect(() => {
    if (desktop && root) void refreshDownloads({ minIntervalMs: 1500 });
  }, [desktop, root]);

  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [formatFilter, setFormatFilter] = useState<FormatFilter>("all");
  const [sortBy, setSortBy] = useState<DownloadVaultSort>("recent");
  const [tidying, setTidying] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [confirmGroup, setConfirmGroup] = useState<string | null>(null);
  const [confirmCleanGroup, setConfirmCleanGroup] = useState<string | null>(null);
  const [confirmEntry, setConfirmEntry] = useState<string | null>(null);
  const [confirmStopAll, setConfirmStopAll] = useState(false);
  const [confirmSeasonKey, setConfirmSeasonKey] = useState<string | null>(null);
  const [fetchingSubId, setFetchingSubId] = useState<string | null>(null);

  const handleTidyVault = async () => {
    if (tidying) return;
    setTidying(true);
    try {
      const res = await organizeDownloadedVault();
      if (!res) return;
      if (res.movedFiles > 0 || res.adoptedFiles > 0) {
        toast(
          `Vault organized · ${res.movedFiles} file${res.movedFiles === 1 ? "" : "s"} sorted, ${res.adoptedFiles} new adopted`,
          { icon: "check" },
        );
      } else {
        toast("Vault folders are already neatly sorted", { icon: "check" });
      }
    } finally {
      setTidying(false);
    }
  };

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
          j.status === "awaitingQuality" ||
          j.status === "failed",
      ),
    [jobs],
  );
  const activeCount = liveJobs.filter(
    (j) => j.status === "queued" || j.status === "downloading" || j.status === "remuxing",
  ).length;
  const pausedCount = liveJobs.filter((j) => j.status === "paused").length;
  const awaitingCount = liveJobs.filter((j) => j.status === "awaitingQuality").length;
  const failedCount = liveJobs.filter((j) => j.status === "failed").length;

  const groups = useMemo(() => groupDownloadedTitles(items), [items]);
  const filtered = useMemo(() => {
    const q = compact ? "" : query.trim().toLowerCase();
    const list = groups.filter((g) => {
      if (!compact && kindFilter !== "all" && g.media.kind !== kindFilter) return false;
      if (
        !compact &&
        formatFilter !== "all" &&
        !g.entries.some((e) => entryContainer(e).toLowerCase() === formatFilter)
      ) {
        return false;
      }
      if (q) {
        const hay = `${g.media.title} ${g.media.originalTitle ?? ""} ${g.media.year ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return compact ? list : sortDownloadedGroups(list, sortBy);
  }, [groups, compact, kindFilter, formatFilter, query, sortBy]);

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
  const presentFormats = new Set(items.map((e) => entryContainer(e).toLowerCase()));

  const deleteGroup = async (g: DownloadedTitleGroup) => {
    for (const entry of g.entries) {
      await removeDownloadedItem(entry.id, true);
    }
    setConfirmGroup(null);
    setConfirmCleanGroup(null);
    setExpandedKeys((prev) => {
      if (!prev.has(g.canonicalKey)) return prev;
      const next = new Set(prev);
      next.delete(g.canonicalKey);
      return next;
    });
    toast(`Deleted “${g.media.title}” · freed ${fmtSize(g.totalSize)}`, { icon: "check" });
  };

  const cleanWatchedForGroup = async (_g: DownloadedTitleGroup, watchedEntries: DownloadedTitleGroup["entries"]) => {
    let freed = 0;
    for (const entry of watchedEntries) {
      freed += entry.fileSize || 0;
      await removeDownloadedItem(entry.id, true);
    }
    setConfirmCleanGroup(null);
    toast(
      `Cleaned ${watchedEntries.length} watched episode${watchedEntries.length === 1 ? "" : "s"} · freed ${fmtSize(freed)}`,
      { icon: "check" },
    );
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
            {!compact && <DownloadPrefsPill />}
            {!compact && root && (
              <>
                <button
                  type="button"
                  className="btn glass sm"
                  disabled={tidying}
                  onClick={() => void handleTidyVault()}
                  title="Scan Downloads folder for unindexed video files and sort files into Movies/Series/Anime folders"
                >
                  <Icon name="refresh" size={14} /> {tidying ? "Tidying…" : "Tidy folders"}
                </button>
                <button
                  type="button"
                  className="btn glass sm"
                  onClick={() => void openDownloadsFolder(root)}
                  title={root}
                >
                  <Icon name="folder" size={14} /> Open folder
                </button>
              </>
            )}
          </div>
        }
      />

      {!compact && (groups.length > 0 || liveJobs.length > 0) && (
        <div className="dlv-overview" aria-label="Offline library overview">
          <div className="dlv-ov-stat">
            <span>Saved storage</span>
            <strong>{fmtSize(totalBytes)} across {items.length} file{items.length === 1 ? "" : "s"}</strong>
          </div>
          <div className="dlv-ov-stat">
            <span>Instant playback</span>
            <strong>
              {items.filter((e) => e.webReady).length}/{items.length} ready now
            </strong>
          </div>
          <div className="dlv-ov-stat">
            <span>Format mix</span>
            <strong>
              {[...presentFormats].map((f) => f.toUpperCase()).join(" · ") || "MP4"}
            </strong>
          </div>
        </div>
      )}

      {!compact && (liveJobs.length > 0 || batch.active) && (
        <div className="dlv-queue glass" aria-label="Active and failed transfers">
          <div className="dlv-queue-head">
            <span>
              TRANSFERS · {liveJobs.length}
              {awaitingCount > 0 ? ` (${awaitingCount} NEEDS CHOICE)` : ""}
              {failedCount > 0 ? ` (${failedCount} FAILED)` : ""}
            </span>
            <div className="dlv-queue-acts">
              {awaitingCount > 0 && (
                <button type="button" className="chip dlq-badge-warn" onClick={() => openQualityReviewModal()}>
                  <Icon name="info" size={11} /> Review quality ({awaitingCount})
                </button>
              )}
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
                        {confirmSeasonKey === `${g.cKey}|${g.season}` && (g.jobs.length > 1 || Boolean(bs)) ? (
                          <>
                            <button
                              type="button"
                              className="chip danger"
                              onClick={() => {
                                setConfirmSeasonKey(null);
                                void cancelAllDownloads({ canonicalKey: g.cKey, season: g.season });
                              }}
                            >
                              Confirm cancel
                            </button>
                            <button type="button" className="chip" onClick={() => setConfirmSeasonKey(null)}>
                              Keep
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="chip danger"
                            onClick={() => {
                              if (g.jobs.length > 1 || Boolean(bs)) setConfirmSeasonKey(`${g.cKey}|${g.season}`);
                              else void cancelAllDownloads({ canonicalKey: g.cKey, season: g.season });
                            }}
                            title={`Stop & clear Season ${g.season} downloads`}
                          >
                            <Icon name="x" size={11} /> Cancel S{g.season}
                          </button>
                        )}
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
                      <span className="dlq-badge-dim">{formatDownloadTransferLabel(j)}</span>
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
                    {j.status === "awaitingQuality" ? (
                      <button
                        type="button"
                        className="chip dlq-badge-warn"
                        onClick={() =>
                          void resolveQualityMismatch(
                            [j.id],
                            "accept",
                            j.availableQuality ?? j.resolvedQuality ?? j.quality,
                          )
                        }
                      >
                        <Icon name="download" size={11} /> Download{" "}
                        {formatResolution(j.availableQuality ?? j.resolvedQuality ?? j.quality) || "best"}
                      </button>
                    ) : busy ? (
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

      {!compact && groups.length > 0 && (
        <div className="dlv-toolbar">
          <div className="dlv-search">
            <Icon name="search" size={14} />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search downloads…"
              aria-label="Search downloaded titles"
            />
          </div>
          {presentKinds.size > 1 && (
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
          {(presentFormats.has("mp4") && presentFormats.has("mkv")) && (
            <div className="dlv-filters" role="tablist" aria-label="Filter downloads by format">
              {(["all", "mp4", "mkv"] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  role="tab"
                  aria-selected={formatFilter === fmt}
                  className={`chip ${formatFilter === fmt ? "on" : ""}`}
                  onClick={() => setFormatFilter(fmt)}
                >
                  {fmt === "all" ? "Any format" : fmt.toUpperCase()}
                </button>
              ))}
            </div>
          )}
          <select
            className="ep-q-pick dlv-sort"
            aria-label="Sort downloads"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as DownloadVaultSort)}
          >
            <option value="recent">Recently saved</option>
            <option value="title">Title A–Z</option>
            <option value="year">Newest release</option>
            <option value="size">Largest size</option>
            <option value="quality">Highest quality</option>
          </select>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="empty dlv-filter-empty">
          <p className="muted">Finished downloads will appear here automatically.</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty dlv-filter-empty">
          <p className="muted">No downloaded titles match the current filters.</p>
          <button
            type="button"
            className="btn glass sm"
            onClick={() => {
              setQuery("");
              setKindFilter("all");
              setFormatFilter("all");
            }}
          >
            Clear filters
          </button>
        </div>
      ) : (
      <div className="dlv-grid">
        {shown.map((g) => {
          const isExp = expandedKeys.has(g.canonicalKey);
          const isConfirm = confirmGroup === g.canonicalKey;
          const isConfirmClean = confirmCleanGroup === g.canonicalKey;
          const qBadge = qualityBadge(g.bestQuality);
          const playTarget = pickPlayTarget(g);
          const playEntry = playTarget.entry;
          const aliasKeys = [g.media.key, ...g.entries.map((e) => e.mediaKey)];
          const watchedEntries = !g.isFilm
            ? g.entries.filter((e) => isEpisodeWatched(g.canonicalKey, e.season ?? 1, e.episode ?? 1, aliasKeys))
            : [];
          const watchedBytes = watchedEntries.reduce((s, e) => s + (e.fileSize || 0), 0);
          const summaryMeta = [
            g.isFilm ? "Film" : `${g.entries.length} episode${g.entries.length === 1 ? "" : "s"}`,
            !g.isFilm && watchedEntries.length > 0 ? `${watchedEntries.length}/${g.entries.length} watched` : null,
            g.media.year,
            fmtSize(g.totalSize),
          ]
            .filter(Boolean)
            .join(" · ");
          const distinctFormats = [...new Set(g.entries.map((e) => entryContainer(e)))];

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
                    const primaryS = (playEntry ?? g.entries[0])?.season ?? 1;
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
                    {distinctFormats.map((fmt) => (
                      <span key={fmt} className="badge dim">
                        {fmt}
                      </span>
                    ))}
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
                      nav(playTargetUrl(g, playEntry), { viewTransition: true, state: { from: "app", offline: true, quick: true } })
                    }
                    title={
                      g.isFilm
                        ? `${playTarget.resume ? "Resume" : "Play"} ${g.media.title}`
                        : `${playTarget.resume ? "Resume" : "Play"} S${playEntry?.season ?? 1} E${playEntry?.episode ?? 1}`
                    }
                  >
                    <Icon name="play" size={14} />
                    <span>
                      {g.isFilm
                        ? playTarget.resume
                          ? "Resume"
                          : "Play"
                        : `${playTarget.resume ? "Resume" : "Play"} S${playEntry?.season ?? 1}E${playEntry?.episode ?? 1}`}
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
                        setExpandedKeys((prev) => {
                          const next = new Set(prev);
                          if (next.has(g.canonicalKey)) next.delete(g.canonicalKey);
                          else next.add(g.canonicalKey);
                          return next;
                        });
                      }}
                    >
                      <Icon name="rows" size={14} />
                      <span>{g.entries.length}</span>
                    </button>
                  )}

                  {!compact && !g.isFilm && watchedEntries.length > 0 && (
                    isConfirmClean ? (
                      <div className="dlv-confirm">
                        <button
                          type="button"
                          className="chip danger"
                          onClick={() => void cleanWatchedForGroup(g, watchedEntries)}
                        >
                          Remove {watchedEntries.length} ({fmtSize(watchedBytes)})
                        </button>
                        <button type="button" className="chip" onClick={() => setConfirmCleanGroup(null)}>
                          Keep
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="chip"
                        title={`Delete ${watchedEntries.length} watched episode file${watchedEntries.length === 1 ? "" : "s"} to free ${fmtSize(watchedBytes)}`}
                        onClick={() => setConfirmCleanGroup(g.canonicalKey)}
                      >
                        Clean {watchedEntries.length} watched
                      </button>
                    )
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
                  {(() => {
                    const seasonNums = new Set(g.entries.map((x) => x.season ?? 1));
                    const showSeasonHdr = seasonNums.size > 1;
                    let lastSeason: number | null = null;
                    return g.entries.map((e) => {
                      const epConfirm = confirmEntry === e.id;
                      const sNum = e.season ?? 1;
                      const eNum = e.episode ?? 1;
                      const needHdr = showSeasonHdr && sNum !== lastSeason;
                      lastSeason = sNum;
                      const code = `S${String(sNum).padStart(2, "0")}E${String(eNum).padStart(2, "0")}`;
                      const epProg = getEpisodeProgress(g.canonicalKey, sNum, eNum, aliasKeys);
                      const watched = isEpisodeWatched(g.canonicalKey, sNum, eNum, aliasKeys);
                      const resumeSec = getResumePosition(g.canonicalKey, sNum, eNum, aliasKeys);
                      const epPct =
                        epProg && epProg.duration > 0
                          ? watched
                            ? 100
                            : Math.min(99, Math.max(4, Math.round((epProg.position / epProg.duration) * 100)))
                          : 0;
                      const leftMin =
                        resumeSec != null && epProg && epProg.duration > 0
                          ? Math.max(1, Math.round((epProg.duration - resumeSec) / 60))
                          : null;
                      return (
                        <div key={e.id}>
                          {needHdr && <div className="dlv-ep-season">Season {sNum}</div>}
                          <div className={`dlv-ep ${watched ? "seen" : ""} ${resumeSec != null ? "in-prog" : ""}`}>
                            <div className="dlv-ep-main">
                              <b>{code}</b>
                              <span>{e.episodeTitle || `Episode ${eNum}`}</span>
                              <small>
                                {[
                                  watched ? "Watched ✓" : leftMin != null ? `${leftMin}m left` : null,
                                  formatQualityTag(e.quality, e.qualityVerified),
                                  entryContainer(e),
                                  e.videoCodec,
                                  e.audio?.toUpperCase(),
                                  fmtSize(e.fileSize),
                                  e.providerName,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </small>
                              {epPct > 0 && (
                                <div className="dlv-ep-bar" aria-hidden>
                                  <i style={{ transform: `scaleX(${epPct / 100})` }} />
                                </div>
                              )}
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
                                className={`chip ${watched ? "on" : ""}`}
                                title={watched ? `Mark ${code} unwatched` : `Mark ${code} watched`}
                                onClick={() => {
                                  const prevSnap = markEpisodeWatched(
                                    { ...g.media, canonicalKey: g.canonicalKey },
                                    sNum,
                                    eNum,
                                    !watched,
                                    epProg?.duration || 1440,
                                    aliasKeys,
                                  );
                                  toast(`${code} marked ${!watched ? "watched" : "unwatched"}`, {
                                    icon: "check",
                                    action: prevSnap
                                      ? { label: "Undo", run: () => restoreProgress(prevSnap) }
                                      : undefined,
                                  });
                                }}
                              >
                                <Icon name="check" size={11} /> {watched ? "Watched" : "Mark watched"}
                              </button>
                              <button
                                type="button"
                                className={`chip ${resumeSec != null ? "play" : ""}`}
                                onClick={() =>
                                  nav(playTargetUrl(g, e), {
                                    viewTransition: true,
                                    state: { from: "app", offline: true, quick: true },
                                  })
                                }
                              >
                                <Icon name="play" size={11} /> {resumeSec != null ? "Resume" : watched ? "Rewatch" : "Play"}
                              </button>
                              {epConfirm ? (
                                <>
                                  <button
                                    type="button"
                                    className="chip danger"
                                    onClick={() => {
                                      setConfirmEntry(null);
                                      void removeDownloadedItem(e.id, true).then(() => {
                                        toast(`Deleted ${code} · freed ${fmtSize(e.fileSize)}`, { icon: "check" });
                                      });
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
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </article>
          );
        })}
      </div>
      )}
    </section>
  );
}

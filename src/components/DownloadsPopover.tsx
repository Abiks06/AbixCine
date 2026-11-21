import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useBatchDownloads } from "../lib/batchDownload";
import { encodeKey } from "../lib/catalog";
import {
  cancelAllDownloads,
  cancelDownload,
  clearFailedDownloads,
  fmtEta,
  fmtSpeed,
  formatDownloadQuality,
  formatQualityTag,
  openDownloadsFolder,
  pauseAllDownloads,
  pauseDownload,
  resumeAllDownloads,
  resumeDownload,
  switchDownloadToNextServer,
  useDownloads,
  type DownloadJob,
} from "../lib/downloads";
import { fmtSize } from "../lib/library";
import { Icon } from "./Icon";

const isJobActive = (j: DownloadJob) =>
  j.status === "queued" || j.status === "downloading" || j.status === "remuxing";

function epChip(j: { isFilm: boolean; season?: number; episode?: number }): string | null {
  if (j.isFilm || j.episode == null) return null;
  return `S${String(j.season ?? 1).padStart(2, "0")}E${String(j.episode).padStart(2, "0")}`;
}

/**
 * Compact topbar Downloads indicator & live transfer queue popover.
 * Hidden until the user has at least one active, queued, paused, or saved download.
 */
export function DownloadsPopover() {
  const desktop = isTauri();
  const { jobs, items, root, switchingIds } = useDownloads();
  const batch = useBatchDownloads();
  const [open, setOpen] = useState(false);
  const [confirmStopAll, setConfirmStopAll] = useState(false);

  useEffect(() => {
    if (!open) {
      setConfirmStopAll(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!desktop) return null;

  const activeJobs = jobs.filter(isJobActive);
  const pausedJobs = jobs.filter((j) => j.status === "paused");
  const failedJobs = jobs.filter((j) => j.status === "failed");
  const visibleJobs = [...activeJobs, ...pausedJobs, ...failedJobs];

  if (visibleJobs.length === 0 && !batch.active && items.length === 0) return null;

  const totalSpeed = activeJobs.reduce((sum, j) => sum + (j.speedBps || 0), 0);
  const avgPct = activeJobs.length
    ? activeJobs.reduce((sum, j) => sum + (j.percent || 0), 0) / activeJobs.length
    : 0;
  const speedText = fmtSpeed(totalSpeed);

  const ringCirc = 2 * Math.PI * 6;
  const ringOffset = ringCirc * (1 - Math.min(1, Math.max(0.04, avgPct / 100)));

  return (
    <div className="dlq-wrap">
      <button
        type="button"
        className={`topbar-dl ${activeJobs.length > 0 || batch.active ? "active" : ""} ${failedJobs.length > 0 && activeJobs.length === 0 ? "has-failed" : ""} ${open ? "on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Downloads queue"
        title={
          activeJobs.length > 0
            ? `${activeJobs.length} downloading · ${Math.round(avgPct)}%${speedText ? ` (${speedText})` : ""}`
            : batch.active
              ? `Finding servers for ${batch.title ?? "season"}`
              : failedJobs.length > 0
                ? `${failedJobs.length} download${failedJobs.length === 1 ? "" : "s"} need attention`
                : `${items.length} saved offline`
        }
        onClick={() => setOpen((o) => !o)}
      >
        {activeJobs.length > 0 || batch.active ? (
          <>
            <svg className="dl-ring" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.22" />
              <circle
                cx="8"
                cy="8"
                r="6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeDasharray={ringCirc}
                strokeDashoffset={batch.active && activeJobs.length === 0 ? ringCirc * 0.65 : ringOffset}
                transform="rotate(-90 8 8)"
              />
            </svg>
            <span className="dl-pct">
              {activeJobs.length > 0 ? `${Math.round(avgPct)}%` : `${batch.queued}/${batch.total}`}
            </span>
            {speedText && <span className="dl-spd">{speedText}</span>}
          </>
        ) : failedJobs.length > 0 ? (
          <>
            <Icon name="info" size={13} />
            <span className="dl-pct">{failedJobs.length} failed</span>
          </>
        ) : pausedJobs.length > 0 ? (
          <>
            <Icon name="pause" size={13} />
            <span className="dl-pct">{pausedJobs.length}</span>
          </>
        ) : (
          <>
            <Icon name="download" size={14} />
            <span className="dl-pct">{items.length}</span>
          </>
        )}
      </button>

      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="dl-queue-pop" role="dialog" aria-label="Downloads queue">
            <div className="tp-pop-head">
              <span>
                DOWNLOADS{" "}
                {activeJobs.length > 0
                  ? `· ${activeJobs.length} ACTIVE`
                  : failedJobs.length > 0
                    ? `· ${failedJobs.length} FAILED`
                    : ""}
              </span>
              <span className="dlq-links">
                {failedJobs.length > 0 && (
                  <button type="button" className="link-btn" onClick={() => void clearFailedDownloads()}>
                    Clear failed
                  </button>
                )}
                {root && (
                  <button type="button" className="link-btn" onClick={() => void openDownloadsFolder(root)}>
                    Folder
                  </button>
                )}
                <Link to="/library" className="link-btn" onClick={() => setOpen(false)} viewTransition>
                  Vault
                </Link>
              </span>
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

            {(visibleJobs.length > 0 || batch.active) && (
              <div className="dlq-bulk-bar" role="group" aria-label="Bulk transfer actions">
                {activeJobs.length > 0 && (
                  <button type="button" className="chip" onClick={() => void pauseAllDownloads()}>
                    <Icon name="pause" size={11} /> Pause all
                  </button>
                )}
                {(pausedJobs.length > 0 || failedJobs.length > 0) && (
                  <button type="button" className="chip" onClick={() => void resumeAllDownloads()}>
                    <Icon name="play" size={11} /> Resume all
                  </button>
                )}
                <span className="grow" />
                {confirmStopAll && visibleJobs.length > 1 ? (
                  <>
                    <button
                      type="button"
                      className="chip danger"
                      onClick={() => {
                        setConfirmStopAll(false);
                        void cancelAllDownloads();
                      }}
                    >
                      Stop all ({visibleJobs.length})
                    </button>
                    <button type="button" className="chip" onClick={() => setConfirmStopAll(false)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="chip danger"
                    title="Stop all active transfers and clear queued, paused, and failed downloads"
                    onClick={() => {
                      if (visibleJobs.length > 1) setConfirmStopAll(true);
                      else void cancelAllDownloads();
                    }}
                  >
                    <Icon name="x" size={11} /> Stop &amp; clear all
                  </button>
                )}
              </div>
            )}

            {(() => {
              const epGroups = new Map<string, { title: string; cKey: string; season: number; jobs: DownloadJob[] }>();
              for (const j of visibleJobs) {
                if (j.isFilm || j.episode == null) continue;
                const cKey = j.canonicalKey || j.mediaKey;
                const sNum = j.season ?? 1;
                const gKey = `${cKey}|${sNum}`;
                const g = epGroups.get(gKey);
                if (g) g.jobs.push(j);
                else epGroups.set(gKey, { title: j.title, cKey, season: sNum, jobs: [j] });
              }
              for (const bs of Object.values(batch.seasons)) {
                const gKey = `${bs.canonicalKey}|${bs.season}`;
                if (!epGroups.has(gKey)) {
                  epGroups.set(gKey, { title: bs.title, cKey: bs.canonicalKey, season: bs.season, jobs: [] });
                }
              }
              const seasonCards = [...epGroups.values()].filter((g) => {
                const bs = batch.seasons[`${g.cKey}|${g.season}`];
                const savedCount = items.filter(
                  (it) => !it.isFilm && (it.canonicalKey === g.cKey || it.mediaKey === g.cKey) && (it.season ?? 1) === g.season,
                ).length;
                return Boolean(bs) || g.jobs.length > 1 || (savedCount > 0 && g.jobs.length >= 1);
              });
              if (!seasonCards.length) return null;
              return seasonCards.map((g) => {
                const bs = batch.seasons[`${g.cKey}|${g.season}`];
                const savedCount = items.filter(
                  (it) => !it.isFilm && (it.canonicalKey === g.cKey || it.mediaKey === g.cKey) && (it.season ?? 1) === g.season,
                ).length;
                const totalCount = bs ? Math.max(bs.total, savedCount + g.jobs.length) : savedCount + g.jobs.length;
                const frac =
                  savedCount + g.jobs.reduce((acc, j) => acc + (j.status === "failed" ? 0 : (j.percent || 0) / 100), 0);
                const pct = totalCount > 0 ? Math.min(100, Math.round((frac / totalCount) * 100)) : 0;
                const quals = [...new Set(g.jobs.map((j) => formatDownloadQuality(j).label).filter(Boolean))];
                const activeInS = g.jobs.filter(isJobActive).length;
                const pausedOrFailedInS = g.jobs.filter((j) => j.status === "paused" || j.status === "failed").length;
                return (
                  <div key={`${g.cKey}|${g.season}`} className="dlq-season-bar">
                    <div className="dlq-sb-top">
                      <span>
                        <b>{g.title} · S{g.season}</b>
                        <small>{savedCount}/{totalCount} offline</small>
                      </span>
                      <span className="dlq-sb-meta">
                        {quals.slice(0, 2).map((ql) => (
                          <span key={ql} className="dlq-badge-q">{ql}</span>
                        ))}
                        <b>{pct}%</b>
                        {activeInS > 0 && (
                          <button
                            type="button"
                            className="icon-btn dlq-sb-ic"
                            title={`Pause Season ${g.season}`}
                            aria-label={`Pause ${g.title} Season ${g.season}`}
                            onClick={() => void pauseAllDownloads({ canonicalKey: g.cKey, season: g.season })}
                          >
                            <Icon name="pause" size={11} />
                          </button>
                        )}
                        {pausedOrFailedInS > 0 && (
                          <button
                            type="button"
                            className="icon-btn dlq-sb-ic"
                            title={`Resume Season ${g.season}`}
                            aria-label={`Resume ${g.title} Season ${g.season}`}
                            onClick={() => void resumeAllDownloads({ canonicalKey: g.cKey, season: g.season })}
                          >
                            <Icon name="play" size={11} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="chip danger dlq-sb-stop"
                          title={`Stop & clear ${g.title} Season ${g.season} downloads`}
                          onClick={() => void cancelAllDownloads({ canonicalKey: g.cKey, season: g.season })}
                        >
                          Stop S{g.season}
                        </button>
                      </span>
                    </div>
                    <div className="dl-bar">
                      <i style={{ transform: `scaleX(${Math.max(0.02, pct / 100)})` }} />
                    </div>
                  </div>
                );
              });
            })()}

            {visibleJobs.length > 0 ? (
              <div className="dlq-list">
                {visibleJobs.map((j) => {
                  const active = isJobActive(j);
                  const chip = epChip(j);
                  const qInfo = formatDownloadQuality(j);
                  const isSwitching = switchingIds.has(j.id);
                  const eta = fmtEta(j.etaSec);
                  const spd = fmtSpeed(j.speedBps);
                  const sizeLine =
                    j.bytesDownloaded > 0
                      ? j.totalBytes
                        ? `${fmtSize(j.bytesDownloaded)} / ${fmtSize(j.totalBytes)}`
                        : fmtSize(j.bytesDownloaded)
                      : null;
                  const meta = [
                    j.providerName,
                    j.error || j.stage,
                    j.segmentsDone != null && j.segmentsTotal ? `${j.segmentsDone}/${j.segmentsTotal} segs` : null,
                    spd || null,
                    eta ? `${eta} left` : sizeLine,
                  ]
                    .filter(Boolean)
                    .join(" · ");

                  return (
                    <div key={j.id} className={`dlq-row ${j.status}`}>
                      <div className="dlq-main">
                        <div className="dlq-title">
                          <strong>{j.title}</strong>
                          {chip && <span className="badge dim">{chip}</span>}
                          <b className="dlq-pct">{Math.round(j.percent)}%</b>
                        </div>
                        <div className="dlq-badges">
                          {qInfo.label && (
                            <span className={`dlq-badge-q ${qInfo.verified ? "verified" : ""}`} title={qInfo.title}>
                              {active ? `Downloading ${qInfo.label}` : qInfo.label}
                              {qInfo.verified ? " ✓" : ""}
                            </span>
                          )}
                          {j.videoCodec && <span className="dlq-badge-dim">{j.videoCodec}</span>}
                          {j.audio && <span className="dlq-badge-dim">{j.audio.toUpperCase()}</span>}
                          <span className="dlq-badge-dim">{j.kind === "hls" ? "HLS→MP4" : "DIRECT"}</span>
                          {((j.attemptIndex ?? 1) > 1 || (j.totalSources ?? 1) > 1) && (
                            <span className="dlq-badge-dim">
                              Server {j.attemptIndex ?? 1}/{Math.max(j.attemptIndex ?? 1, j.totalSources ?? 1)}
                            </span>
                          )}
                        </div>
                        <small>{meta}</small>
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
                        {active ? (
                          <button
                            type="button"
                            className="icon-btn"
                            title="Pause download"
                            aria-label={`Pause ${j.title}`}
                            disabled={j.status === "remuxing"}
                            onClick={() => void pauseDownload(j.id)}
                          >
                            <Icon name="pause" size={13} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="icon-btn"
                            title={j.status === "failed" ? "Retry same server" : "Resume download"}
                            aria-label={`Resume ${j.title}`}
                            onClick={() => void resumeDownload(j.id)}
                          >
                            <Icon name={j.status === "failed" ? "refresh" : "play"} size={13} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-btn"
                          title="Try another server"
                          aria-label={`Switch server for ${j.title}`}
                          disabled={j.status === "remuxing" || isSwitching}
                          onClick={() => void switchDownloadToNextServer(j)}
                        >
                          <Icon name="shuffle" size={13} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Cancel & clean temporary files"
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
            ) : (
              <div className="dlq-saved-list">
                {items.slice(0, 4).map((it) => {
                  const chip = epChip(it);
                  return (
                    <Link
                      key={it.id}
                      to={`/title/${encodeKey(it.canonicalKey)}`}
                      className="dlq-saved-row"
                      onClick={() => setOpen(false)}
                      viewTransition
                    >
                      <span className="dlq-saved-name">
                        <strong>{it.title}</strong>
                        <small>
                          {[
                            chip,
                            formatQualityTag(it.quality, it.qualityVerified),
                            it.videoCodec,
                            fmtSize(it.fileSize),
                            it.providerName,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </span>
                      <span className="badge on">OFFLINE</span>
                    </Link>
                  );
                })}
                {items.length === 0 && (
                  <p className="muted dlq-empty">No downloads in progress.</p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { cancelBatchDownloads, useBatchDownloads } from "../lib/batchDownload";
import { encodeKey } from "../lib/catalog";
import {
  cancelDownload,
  fmtEta,
  fmtSpeed,
  openDownloadsFolder,
  pauseDownload,
  resumeDownload,
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
  const { jobs, items, root } = useDownloads();
  const batch = useBatchDownloads();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
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
        className={`topbar-dl ${activeJobs.length > 0 || batch.active ? "active" : ""} ${open ? "on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Downloads queue"
        title={
          activeJobs.length > 0
            ? `${activeJobs.length} downloading · ${Math.round(avgPct)}%${speedText ? ` (${speedText})` : ""}`
            : batch.active
              ? `Finding servers for ${batch.title ?? "season"}`
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
                DOWNLOADS {activeJobs.length > 0 ? `· ${activeJobs.length} ACTIVE` : ""}
              </span>
              <span className="dlq-links">
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
                <button type="button" className="chip" onClick={cancelBatchDownloads}>
                  Stop
                </button>
              </div>
            )}

            {visibleJobs.length > 0 ? (
              <div className="dlq-list">
                {visibleJobs.map((j) => {
                  const active = isJobActive(j);
                  const chip = epChip(j);
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
                        <small>{meta}</small>
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
                            title={j.status === "failed" ? "Retry download" : "Resume download"}
                            aria-label={`Resume ${j.title}`}
                            onClick={() => void resumeDownload(j.id)}
                          >
                            <Icon name={j.status === "failed" ? "refresh" : "play"} size={13} />
                          </button>
                        )}
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
                          {[chip, it.quality ? `${it.quality}p` : null, fmtSize(it.fileSize), it.providerName]
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

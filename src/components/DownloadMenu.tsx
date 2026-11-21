import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { downloadFormatLabel, rankDownloadOptions } from "../lib/downloadRank";
import {
  cancelDownload,
  findDownloadedEntries,
  findDownloadJob,
  fmtEta,
  fmtSpeed,
  formatDownloadQuality,
  openDownloadsFolder,
  pauseDownload,
  removeDownloadedItem,
  resumeDownload,
  startDownload,
  switchDownloadToNextServer,
  useDownloads,
} from "../lib/downloads";
import { fmtSize } from "../lib/library";
import { updateSettings, useSettings } from "../lib/settings";
import type { MediaDetail, PlaybackRequest } from "../lib/types";
import { candKey } from "../sources/registry";
import { useSourceSession } from "../sources/useSourceSession";
import { Icon } from "./Icon";
import { audioLabel, qualityLabel } from "./SourceBoard";

/**
 * Title-page Download action + implicitly ranked server chooser popover.
 * Shares the active SourceSession with SmartSource so no extra server lookups are triggered.
 */
export function DownloadMenu({
  req,
  detail,
  what,
  episodeTitle,
}: {
  req: PlaybackRequest;
  detail?: MediaDetail;
  what: string;
  episodeTitle?: string;
}) {
  const desktop = isTauri();
  const s = useSettings();
  const { snap } = useSourceSession(desktop ? req : null, 1);
  const { jobs, items, root, switchingIds } = useDownloads();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ranked = useMemo(
    () => (snap ? rankDownloadOptions(snap.candidates, s.preferredQuality) : []),
    [snap, s.preferredQuality],
  );

  if (!desktop) return null;

  const activeJob = findDownloadJob(req, undefined, jobs);
  const savedEntries = findDownloadedEntries(req, items);
  const saved = savedEntries[0];
  const isBusy =
    activeJob &&
    (activeJob.status === "queued" || activeJob.status === "downloading" || activeJob.status === "remuxing");
  const isPaused = activeJob?.status === "paused";
  const isFailed = activeJob?.status === "failed";
  const pct = activeJob ? Math.round(activeJob.percent) : 0;
  const preferredLabel = s.preferredQuality >= 2160 ? "4K" : `${s.preferredQuality}p`;
  const activeQNum = activeJob?.resolvedQuality ?? activeJob?.quality ?? activeJob?.preferredQuality;
  const activeQStr = activeQNum ? (activeQNum >= 2160 ? "4K" : `${activeQNum}p`) : null;
  const savedQLabel = saved?.quality ? (saved.quality >= 2160 ? "4K" : `${saved.quality}p`) : null;

  const btnLabel = isBusy
    ? activeJob.status === "remuxing"
      ? `Saving${activeQStr ? ` ${activeQStr}` : ""}…`
      : activeJob.status === "queued"
        ? `Queued${activeQStr ? ` · ${activeQStr}` : ""}`
        : `${activeQStr ? `${activeQStr} · ` : ""}${pct}%`
    : isFailed
      ? "Retry"
      : isPaused
        ? `Paused · ${activeQStr ? `${activeQStr} · ` : ""}${pct}%`
        : saved
          ? `Saved${savedQLabel ? ` · ${savedQLabel}` : ""}`
          : "Download";

  const activeQ = activeJob ? formatDownloadQuality(activeJob) : null;
  const activeSpeed = activeJob ? fmtSpeed(activeJob.speedBps) : "";
  const activeEta = activeJob ? fmtEta(activeJob.etaSec) : "";
  const activeSwitching = activeJob ? switchingIds.has(activeJob.id) : false;

  return (
    <div className={`dl-wrap ${open ? "open" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className={`btn glass ${saved ? "on" : ""} ${isBusy ? "busy" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((x) => !x)}
        title={saved ? `${what} saved offline` : `Download ${what}`}
      >
        <Icon name={saved && !isBusy && !isPaused ? "check" : isFailed ? "info" : isPaused ? "pause" : "download"} size={17} />
        <span>{btnLabel}</span>
      </button>

      {open && (
        <div className="dl-pop glass" role="dialog" aria-label={`Download options for ${what}`}>
          <div className="dl-pop-head">
            <span>
              <Icon name="download" size={14} /> Download {what}
            </span>
            {root && (
              <button
                type="button"
                className="link-btn"
                onClick={() => void openDownloadsFolder()}
                title={root}
              >
                Open folder
              </button>
            )}
          </div>

          <div className="dl-qbar" aria-label="Target download quality">
            <span className="dl-qbar-lbl">
              Target quality <small>({preferredLabel})</small>
            </span>
            <div className="dl-qbar-pills">
              {[2160, 1080, 720, 480].map((q) => (
                <button
                  key={q}
                  type="button"
                  className={`chip ${s.preferredQuality === q ? "on" : ""}`}
                  onClick={() => updateSettings({ preferredQuality: q })}
                >
                  {q >= 2160 ? "4K" : `${q}p`}
                </button>
              ))}
            </div>
          </div>

          {saved && (
            <div className="dl-saved-card">
              <div>
                <strong>
                  Downloaded in {savedQLabel ?? "HD"}
                  {saved.qualityVerified ? " ✓" : ""}
                </strong>
                <small>
                  {[
                    saved.providerName,
                    savedQLabel ? `${savedQLabel}${saved.qualityVerified ? " verified" : ""}` : null,
                    saved.videoCodec,
                    fmtSize(saved.fileSize),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </div>
              <button
                type="button"
                className="icon-btn"
                title="Remove downloaded copy"
                aria-label="Remove downloaded copy"
                onClick={() => void removeDownloadedItem(saved.id, true)}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          )}

          {activeJob && (isBusy || isPaused || isFailed) && (
            <div className={`dl-active-card ${isFailed ? "failed" : ""}`}>
              <div className="dl-active-top">
                <span>
                  <b>{activeJob.providerName}</b>
                  <small>
                    {[
                      activeJob.error || activeJob.stage || activeJob.status,
                      activeJob.segmentsDone != null && activeJob.segmentsTotal
                        ? `${activeJob.segmentsDone}/${activeJob.segmentsTotal} segs`
                        : null,
                      activeJob.bytesDownloaded > 0
                        ? activeJob.totalBytes
                          ? `${fmtSize(activeJob.bytesDownloaded)} / ${fmtSize(activeJob.totalBytes)}`
                          : fmtSize(activeJob.bytesDownloaded)
                        : null,
                      activeSpeed || null,
                      activeEta ? `${activeEta} left` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </span>
                <b>{Math.round(activeJob.percent)}%</b>
              </div>
              <div className="dl-active-badges">
                {activeQ && (
                  <span className={`dlq-badge-q ${activeQ.verified ? "verified" : ""}`} title={activeQ.title}>
                    Downloading {activeQ.label}
                    {activeQ.verified ? " ✓" : ""}
                  </span>
                )}
                {activeJob.videoCodec && <span className="dlq-badge-dim">{activeJob.videoCodec}</span>}
                <span className="dlq-badge-dim">{activeJob.kind === "hls" ? "HLS→MP4" : "DIRECT"}</span>
                {((activeJob.attemptIndex ?? 1) > 1 || (activeJob.totalSources ?? 1) > 1) && (
                  <span className="dlq-badge-dim">
                    Server {activeJob.attemptIndex ?? 1}/{Math.max(activeJob.attemptIndex ?? 1, activeJob.totalSources ?? 1)}
                  </span>
                )}
              </div>
              {activeJob.failoverNotes && activeJob.failoverNotes.length > 0 && (
                <div className="dl-fail-note">
                  Backup switch after: {activeJob.failoverNotes[activeJob.failoverNotes.length - 1]}
                </div>
              )}
              <div className="dl-bar">
                <i style={{ transform: `scaleX(${Math.max(0.02, activeJob.percent / 100)})` }} />
              </div>
              <div className="dl-active-acts">
                {isBusy ? (
                  <button
                    type="button"
                    className="chip"
                    disabled={activeJob.status === "remuxing"}
                    onClick={() => void pauseDownload(activeJob.id)}
                  >
                    <Icon name="pause" size={12} /> Pause
                  </button>
                ) : (
                  <button type="button" className="chip" onClick={() => void resumeDownload(activeJob.id)}>
                    <Icon name="play" size={12} /> {isFailed ? "Retry" : "Resume"}
                  </button>
                )}
                <button
                  type="button"
                  className="chip"
                  disabled={activeSwitching || activeJob.status === "remuxing"}
                  onClick={() => void switchDownloadToNextServer(activeJob)}
                  title="Switch to the next best working server"
                >
                  <Icon name="shuffle" size={12} /> {activeSwitching ? "Switching…" : "Switch server"}
                </button>
                <button type="button" className="chip" onClick={() => void cancelDownload(activeJob.id)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {ranked.length > 0 && !isBusy && !saved && (
            <button
              type="button"
              className="dl-quick-cta"
              onClick={() => {
                const top = ranked[0];
                void startDownload(req, top, detail, episodeTitle, {
                  fallbacks: ranked.slice(1, 7),
                  preferredQuality: s.preferredQuality,
                  replaceExisting: true,
                });
              }}
            >
              <Icon name="download" size={14} />
              <span>
                <strong>Quick download · {ranked[0].providerName}</strong>
                <small>
                  Up to {preferredLabel}
                  {ranked.length > 1
                    ? ` · ${Math.min(6, ranked.length - 1)} backup server${Math.min(6, ranked.length - 1) === 1 ? "" : "s"} ready`
                    : ""}
                </small>
              </span>
            </button>
          )}

          <div className="dl-pop-list">
            {ranked.length > 0 ? (
              ranked.map((c) => {
                const q = qualityLabel(c);
                const audio = audioLabel(c);
                const fmt = downloadFormatLabel(c);
                const subCount = c.subtitles?.length ?? 0;
                const rowJob = findDownloadJob(req, c, jobs);
                const rowBusy =
                  rowJob &&
                  (rowJob.status === "queued" || rowJob.status === "downloading" || rowJob.status === "remuxing");
                return (
                  <button
                    key={candKey(c)}
                    type="button"
                    className="dl-opt"
                    disabled={Boolean(rowBusy)}
                    onClick={() => {
                      void startDownload(req, c, detail, episodeTitle, {
                        fallbacks: ranked.filter((x) => x !== c).slice(0, 6),
                        preferredQuality: s.preferredQuality,
                        replaceExisting: true,
                      });
                    }}
                  >
                    <span className="dl-opt-main">
                      <strong>{c.providerName}</strong>
                      <small>
                        {fmt}
                        {subCount > 0 ? ` · ${subCount} sub${subCount > 1 ? "s" : ""}` : ""}
                      </small>
                    </span>
                    <span className="dl-opt-tags">
                      {q && <b>{q}</b>}
                      {audio && <b>{audio}</b>}
                    </span>
                    <span className="dl-opt-act">
                      {rowBusy ? `${Math.round(rowJob.percent)}%` : <Icon name="download" size={14} />}
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="dl-pop-empty">
                {snap?.busy
                  ? "Scanning servers for downloadable streams…"
                  : "No direct or HLS download streams verified yet. Open a server on the right or try again shortly."}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

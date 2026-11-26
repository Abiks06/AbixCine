import { useEffect, useRef, useState } from "react";
import { queueEpisodeDownload } from "../lib/batchDownload";
import { useDownloadPrefs } from "../lib/downloadOverrides";
import { formatResolution } from "../lib/downloadRank";
import {
  cancelDownload,
  entryContainer,
  fmtEta,
  fmtSpeed,
  formatDownloadQuality,
  formatDownloadTransferLabel,
  openDownloadsFolder,
  pauseDownload,
  removeDownloadedItem,
  resolveQualityMismatch,
  resumeDownload,
  switchDownloadToNextServer,
  useDownloads,
  type DownloadJob,
  type DownloadedEntry,
} from "../lib/downloads";
import { fmtSize } from "../lib/library";
import type { Audio, DownloadFormat, DownloadQualityPolicy } from "../lib/settings";
import type { Episode, MediaDetail } from "../lib/types";
import { openQualityReviewModal } from "./DownloadQualityModal";
import { Icon } from "./Icon";

const QUALITIES = [2160, 1080, 720, 480] as const;

const FORMAT_OPTIONS: { id: DownloadFormat; label: string; hint: string }[] = [
  { id: "mp4", label: "MP4", hint: "Instant play · stereo AAC" },
  { id: "mkv", label: "MKV", hint: "Soft subtitles · Matroska" },
];

const POLICY_OPTIONS: { id: DownloadQualityPolicy; label: string; hint: string }[] = [
  { id: "ask", label: "Ask me", hint: "Hold & ask if target quality isn't found" },
  { id: "strict", label: "Exact only", hint: "Only save exact target quality" },
  { id: "best", label: "Best available", hint: "Auto-save closest resolution" },
];

/**
 * Unified pill (`1080p · MP4 ▾`) controlling persisted download resolution & container
 * format across Title, Episodes, QuickDossier, and Downloads Vault.
 */
export function DownloadPrefsPill({
  compact = false,
  align = "right",
}: {
  compact?: boolean;
  align?: "left" | "right";
}) {
  const dlPrefs = useDownloadPrefs();
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

  const qLabel = dlPrefs.quality >= 2160 ? "4K" : `${dlPrefs.quality}p`;
  const fmtLabel = dlPrefs.format.toUpperCase();

  return (
    <div className={`dl-prefs-wrap ${compact ? "compact" : ""} ${open ? "open" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className={`dl-prefs-pill ${open ? "on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Download defaults: ${qLabel} ${fmtLabel}`}
        title={`Download quality (${qLabel}) & format (${fmtLabel})`}
        onClick={() => setOpen((x) => !x)}
      >
        <Icon name="sliders" size={12} />
        <span className="dl-prefs-val">
          <b>{qLabel}</b>
          <i>·</i>
          <b>{fmtLabel}</b>
        </span>
        <svg className="dl-prefs-caret" viewBox="0 0 12 12" width="11" height="11" aria-hidden>
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className={`dl-prefs-pop align-${align}`} role="dialog" aria-label="Download quality and format">
          <div className="dl-prefs-sec">
            <span className="dl-prefs-lbl">Target quality</span>
            <div className="dl-prefs-chips" role="group" aria-label="Target quality">
              {QUALITIES.map((q) => (
                <button
                  key={q}
                  type="button"
                  className={`chip ${dlPrefs.quality === q ? "on" : ""}`}
                  aria-pressed={dlPrefs.quality === q}
                  onClick={() => dlPrefs.setQuality(q)}
                >
                  {q >= 2160 ? "4K" : `${q}p`}
                </button>
              ))}
            </div>
          </div>

          <div className="dl-prefs-sec">
            <span className="dl-prefs-lbl">Container format</span>
            <div className="dl-prefs-fmts" role="group" aria-label="Container format">
              {FORMAT_OPTIONS.map((f) => {
                const active = dlPrefs.format === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    className={`dl-fmt-opt ${active ? "on" : ""}`}
                    aria-pressed={active}
                    onClick={() => dlPrefs.setFormat(f.id)}
                  >
                    <strong>{f.label}</strong>
                    <small>{f.hint}</small>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="dl-prefs-sec">
            <span className="dl-prefs-lbl">If quality unavailable</span>
            <div className="dl-prefs-chips" role="group" aria-label="If target quality is unavailable">
              {POLICY_OPTIONS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`chip ${dlPrefs.policy === p.id ? "on" : ""}`}
                  aria-pressed={dlPrefs.policy === p.id}
                  title={p.hint}
                  onClick={() => dlPrefs.setPolicy(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const RING_R = 14;
const RING_C = 2 * Math.PI * RING_R;

/**
 * Netflix-Desktop-inspired circular episode download control:
 * - Idle: 1-click download button
 * - Active: circular SVG progress sweep ring + click popover (Pause, Switch server, Cancel)
 * - Paused / Failed: status ring + click popover (Resume / Retry / Clear)
 * - Saved: clickable offline badge pill (`✓ 1080p MP4`) + click popover (Play, Folder, Remove)
 */
export function EpisodeDownloadControl({
  detail,
  season,
  ep,
  audio,
  entry,
  job,
  resolving = false,
  onPlayOffline,
}: {
  detail: MediaDetail;
  season: number;
  ep: Episode;
  audio?: Audio;
  entry?: DownloadedEntry;
  job?: DownloadJob;
  resolving?: boolean;
  onPlayOffline?: () => void;
}) {
  const dlPrefs = useDownloadPrefs();
  const { switchingIds } = useDownloads();
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const isBusy =
    job && (job.status === "queued" || job.status === "downloading" || job.status === "remuxing");
  const isPaused = job?.status === "paused";
  const isAwaiting = job?.status === "awaitingQuality";
  const isFailed = job?.status === "failed";
  const isSaved = Boolean(entry) && !isBusy && !isPaused && !isAwaiting && !isFailed;
  const hasPopoverState = Boolean(isBusy || isPaused || isAwaiting || isFailed || isSaved);

  useEffect(() => {
    if (!open) {
      setConfirmDelete(false);
      return;
    }
    if (!hasPopoverState) {
      setOpen(false);
      return;
    }
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
  }, [open, hasPopoverState]);

  const pct = job ? Math.max(0, Math.min(100, job.percent || 0)) : 0;
  const dashOffset = RING_C * (1 - pct / 100);
  const qLabel = dlPrefs.quality >= 2160 ? "4K" : `${dlPrefs.quality}p`;
  const fmtLabel = dlPrefs.format.toUpperCase();
  const savedQTag = entry?.quality ? (entry.quality >= 2160 ? "4K" : `${entry.quality}p`) : null;
  const savedFmt = entry ? entryContainer(entry) : null;
  const switching = job ? switchingIds.has(job.id) : false;
  const activeQ = job ? formatDownloadQuality(job) : null;
  const speed = job ? fmtSpeed(job.speedBps) : "";
  const eta = job ? fmtEta(job.etaSec) : "";

  const availQ = job?.availableQuality ?? job?.resolvedQuality ?? job?.quality;
  const availQStr = formatResolution(availQ) || "lower quality";
  const targetQStr = formatResolution(job?.preferredQuality ?? dlPrefs.quality) || `${dlPrefs.quality}p`;

  const btnTitle = resolving
    ? `Finding stream for E${ep.number}…`
    : isAwaiting
      ? `No ${targetQStr} found for E${ep.number} · Best: ${availQStr} — click to choose`
      : isBusy
        ? `${job.status === "remuxing" ? "Saving" : "Downloading"} E${ep.number} · ${Math.round(pct)}% — click for options`
        : isPaused
          ? `Paused E${ep.number} (${Math.round(pct)}%) — click for options`
          : isFailed
            ? `Download failed for E${ep.number} — click to retry`
            : isSaved
              ? `E${ep.number} saved offline (${[savedQTag, savedFmt].filter(Boolean).join(" ")}) — click for options`
              : `Download E${ep.number} (${qLabel} ${fmtLabel})`;

  const onButtonClick = () => {
    if (resolving) return;
    if (hasPopoverState) {
      setOpen((x) => !x);
      return;
    }
    void queueEpisodeDownload(detail, season, ep, audio, dlPrefs.quality, dlPrefs.format, dlPrefs.policy);
  };

  return (
    <div className={`ep-dl-ctrl ${open ? "open" : ""}`} ref={wrapRef}>
      {isSaved && entry ? (
        <button
          type="button"
          className={`ep-dl-saved-pill ${open ? "on" : ""}`}
          title={btnTitle}
          aria-label={btnTitle}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={onButtonClick}
        >
          <Icon name="check" size={12} />
          <span>{[savedQTag, savedFmt].filter(Boolean).join(" ") || "Saved"}</span>
        </button>
      ) : (
        <button
          type="button"
          className={`ep-dl-ring ${resolving ? "resolving" : ""} ${isBusy ? "busy" : ""} ${job?.status === "remuxing" ? "remuxing" : ""} ${isPaused ? "paused" : ""} ${isAwaiting ? "awaiting" : ""} ${isFailed ? "failed" : ""} ${open ? "on" : ""}`}
          title={btnTitle}
          aria-label={btnTitle}
          aria-expanded={hasPopoverState ? open : undefined}
          aria-haspopup={hasPopoverState ? "dialog" : undefined}
          disabled={resolving}
          onClick={onButtonClick}
        >
          {(isBusy || isPaused || isAwaiting || isFailed) && (
            <svg className="ep-ring-svg" viewBox="0 0 36 36" aria-hidden>
              <circle className="ep-ring-track" cx="18" cy="18" r={RING_R} />
              <circle
                className="ep-ring-fill"
                cx="18"
                cy="18"
                r={RING_R}
                strokeDasharray={RING_C}
                strokeDashoffset={isFailed || isAwaiting ? 0 : dashOffset}
              />
            </svg>
          )}
          <span className="ep-ring-core" aria-hidden>
            {resolving ? (
              <span className="mini-spin" />
            ) : isBusy ? (
              job.status === "remuxing" ? (
                <Icon name="check" size={12} />
              ) : (
                <Icon name="pause" size={11} />
              )
            ) : isAwaiting ? (
              <Icon name="info" size={12} />
            ) : isPaused ? (
              <Icon name="play" size={11} />
            ) : isFailed ? (
              <Icon name="refresh" size={12} />
            ) : (
              <Icon name="download" size={14} />
            )}
          </span>
        </button>
      )}

      {open && hasPopoverState && (
        <div className="ep-dl-pop" role="dialog" aria-label={`Episode ${ep.number} download options`}>
          {isSaved && entry && (
            <>
              <div className="ep-dl-pop-head">
                <strong>S{season} · E{ep.number} saved offline</strong>
                <small>
                  {[
                    savedQTag ? `${savedQTag}${entry.qualityVerified ? " ✓" : ""}` : null,
                    savedFmt,
                    entry.videoCodec,
                    fmtSize(entry.fileSize),
                    entry.providerName,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </div>
              <div className="ep-dl-pop-acts">
                {onPlayOffline && (
                  <button
                    type="button"
                    className="btn play xs"
                    onClick={() => {
                      setOpen(false);
                      onPlayOffline();
                    }}
                  >
                    <Icon name="play" size={12} /> Play offline
                  </button>
                )}
                <button
                  type="button"
                  className="chip"
                  onClick={() => {
                    setOpen(false);
                    void openDownloadsFolder(entry.filePath);
                  }}
                >
                  <Icon name="folder" size={12} /> Folder
                </button>
                {confirmDelete ? (
                  <>
                    <button
                      type="button"
                      className="chip danger"
                      onClick={() => {
                        setConfirmDelete(false);
                        setOpen(false);
                        void removeDownloadedItem(entry.id, true);
                      }}
                    >
                      Delete file
                    </button>
                    <button type="button" className="chip" onClick={() => setConfirmDelete(false)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="chip danger"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Icon name="trash" size={12} /> Remove
                  </button>
                )}
              </div>
            </>
          )}

          {job && isAwaiting && (
            <>
              <div className="ep-dl-pop-head">
                <strong>No {targetQStr} source found</strong>
                <small>
                  Best available: {availQStr} · {job.providerName}
                </small>
              </div>
              <div className="ep-dl-pop-acts">
                <button
                  type="button"
                  className="btn play xs"
                  onClick={() => {
                    setOpen(false);
                    void resolveQualityMismatch([job.id], "accept", availQ);
                  }}
                >
                  <Icon name="download" size={12} /> Download {availQStr}
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() => {
                    setOpen(false);
                    openQualityReviewModal();
                  }}
                >
                  Review all
                </button>
                <button
                  type="button"
                  className="chip danger"
                  onClick={() => {
                    setOpen(false);
                    void resolveQualityMismatch([job.id], "cancel");
                  }}
                >
                  <Icon name="x" size={12} /> Cancel
                </button>
              </div>
            </>
          )}

          {job && !isAwaiting && (isBusy || isPaused || isFailed) && (
            <>
              <div className="ep-dl-pop-head">
                <strong>
                  {isFailed
                    ? `E${ep.number} failed`
                    : isPaused
                      ? `E${ep.number} paused · ${Math.round(pct)}%`
                      : job.status === "remuxing"
                        ? `Saving E${ep.number}…`
                        : `E${ep.number} · ${Math.round(pct)}%`}
                </strong>
                <small>
                  {[
                    job.providerName,
                    activeQ?.label,
                    formatDownloadTransferLabel(job),
                    speed || null,
                    eta ? `${eta} left` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
                {isFailed && job.error && <span className="ep-dl-err">{job.error}</span>}
              </div>
              {(isBusy || isPaused) && (
                <div className="dl-bar" aria-hidden>
                  <i style={{ transform: `scaleX(${Math.max(0.02, pct / 100)})` }} />
                </div>
              )}
              <div className="ep-dl-pop-acts">
                {isBusy ? (
                  <button
                    type="button"
                    className="chip"
                    disabled={job.status === "remuxing"}
                    onClick={() => void pauseDownload(job.id)}
                  >
                    <Icon name="pause" size={12} /> Pause
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn play xs"
                    onClick={() => void resumeDownload(job.id)}
                  >
                    <Icon name="play" size={12} /> {isFailed ? "Retry" : "Resume"}
                  </button>
                )}
                <button
                  type="button"
                  className="chip"
                  disabled={switching || job.status === "remuxing"}
                  onClick={() => void switchDownloadToNextServer(job)}
                >
                  <Icon name="shuffle" size={12} /> {switching ? "Switching…" : "Next server"}
                </button>
                <button
                  type="button"
                  className="chip danger"
                  onClick={() => {
                    setOpen(false);
                    void cancelDownload(job.id);
                  }}
                >
                  <Icon name="x" size={12} /> {isFailed ? "Clear" : "Cancel"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDownloadPrefs } from "../lib/downloadOverrides";
import { downloadFormatLabel, formatResolution, rankDownloadOptions } from "../lib/downloadRank";
import {
  cancelDownload,
  entryContainer,
  findDownloadedEntries,
  findDownloadJob,
  fmtEta,
  fmtSpeed,
  formatDownloadQuality,
  formatDownloadTransferLabel,
  openDownloadsFolder,
  pauseDownload,
  removeDownloadedItem,
  resolveQualityMismatch,
  resumeDownload,
  startDownload,
  switchDownloadToNextServer,
  useDownloads,
} from "../lib/downloads";
import { fmtSize } from "../lib/library";
import type { DownloadFormat, DownloadQualityPolicy } from "../lib/settings";
import type { MediaDetail, PlaybackRequest } from "../lib/types";
import { candKey } from "../sources/registry";
import { useSourceSession } from "../sources/useSourceSession";
import { Icon } from "./Icon";
import { audioLabel, qualityLabel } from "./SourceBoard";

/**
 * Netflix-Desktop-inspired split Download CTA:
 * - Primary button triggers 1-click download in your chosen quality/format (or opens management when active/saved)
 * - Attached chevron opens quality/format defaults, active transfer controls, and optional manual server picker
 */
export function DownloadMenu({
  req,
  detail,
  what,
  episodeTitle,
  size = "md",
}: {
  req: PlaybackRequest;
  detail?: MediaDetail;
  what: string;
  episodeTitle?: string;
  size?: "md" | "sm";
}) {
  const desktop = isTauri();
  const dlPrefs = useDownloadPrefs();
  const { snap } = useSourceSession(desktop ? req : null, 1);
  const { jobs, items, root, switchingIds } = useDownloads();
  const [open, setOpen] = useState(false);
  const [showServers, setShowServers] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const targetQuality = dlPrefs.quality;
  const targetFormat = dlPrefs.format;
  const targetLabel = targetQuality >= 2160 ? "4K" : `${targetQuality}p`;
  const formatLabel = targetFormat.toUpperCase();

  useEffect(() => {
    if (!open) {
      setConfirmDelete(false);
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
  }, [open]);

  const ranked = useMemo(
    () => (snap ? rankDownloadOptions(snap.candidates, targetQuality) : []),
    [snap, targetQuality],
  );

  if (!desktop) return null;

  const activeJob = findDownloadJob(req, undefined, jobs);
  const savedEntries = findDownloadedEntries(req, items);
  const saved = savedEntries[0];
  const isBusy =
    activeJob &&
    (activeJob.status === "queued" || activeJob.status === "downloading" || activeJob.status === "remuxing");
  const isPaused = activeJob?.status === "paused";
  const isAwaiting = activeJob?.status === "awaitingQuality";
  const isFailed = activeJob?.status === "failed";
  const pct = activeJob ? Math.round(activeJob.percent) : 0;
  const activeQNum = activeJob?.resolvedQuality ?? activeJob?.quality ?? activeJob?.preferredQuality;
  const activeQStr = activeQNum ? (activeQNum >= 2160 ? "4K" : `${activeQNum}p`) : null;
  const availQNum = activeJob?.availableQuality ?? activeJob?.resolvedQuality ?? activeJob?.quality;
  const availQStr = formatResolution(availQNum) || "lower";
  const savedQLabel = saved?.quality ? (saved.quality >= 2160 ? "4K" : `${saved.quality}p`) : null;
  const savedFmtLabel = saved ? entryContainer(saved) : null;

  const triggerQuickDownload = () => {
    const top = ranked[0];
    if (!top) {
      setOpen(true);
      return;
    }
    void startDownload(req, top, detail, episodeTitle, {
      fallbacks: ranked.slice(1, 11),
      preferredQuality: targetQuality,
      preferredFormat: targetFormat,
      qualityPolicy: dlPrefs.policy,
      replaceExisting: true,
    });
  };

  const mainLabel = isBusy ? (
    activeJob.status === "remuxing" ? (
      <span>Saving {activeQStr ?? ""}…</span>
    ) : activeJob.status === "queued" ? (
      <span>Queued{activeQStr ? ` · ${activeQStr}` : ""}</span>
    ) : (
      <span>{activeQStr ? `${activeQStr} · ` : ""}{pct}%</span>
    )
  ) : isAwaiting ? (
    <span>No {targetLabel} · {availQStr}?</span>
  ) : isFailed ? (
    <span>Retry download</span>
  ) : isPaused ? (
    <span>Paused · {pct}%</span>
  ) : saved ? (
    <span>Saved · {[savedQLabel, savedFmtLabel].filter(Boolean).join(" ")}</span>
  ) : (
    <>
      <span>Download</span>
      <small className="dl-split-spec">{targetLabel} {formatLabel}</small>
    </>
  );

  const mainIcon =
    saved && !isBusy && !isPaused && !isAwaiting && !isFailed
      ? "check"
      : isAwaiting
        ? "info"
        : isFailed
          ? "refresh"
          : isPaused
            ? "pause"
            : "download";

  const onMainClick = () => {
    if (isBusy || isPaused || isAwaiting || isFailed || saved) {
      setOpen((x) => !x);
      return;
    }
    triggerQuickDownload();
  };

  const activeQ = activeJob ? formatDownloadQuality(activeJob) : null;
  const activeSpeed = activeJob ? fmtSpeed(activeJob.speedBps) : "";
  const activeEta = activeJob ? fmtEta(activeJob.etaSec) : "";
  const activeSwitching = activeJob ? switchingIds.has(activeJob.id) : false;

  const btnSz = size === "sm" ? " sm" : "";
  return (
    <div className={`dl-wrap ${open ? "open" : ""}`} ref={wrapRef}>
      <div className={`dl-split ${saved && !isBusy && !isPaused && !isAwaiting && !isFailed ? "on" : ""} ${isBusy ? "busy" : ""} ${isAwaiting ? "awaiting" : ""} ${isFailed ? "failed" : ""}`}>
        <button
          type="button"
          className={`btn glass${btnSz} dl-split-main`}
          onClick={onMainClick}
          title={
            saved
              ? `${what} saved offline — manage download`
              : isBusy || isPaused || isAwaiting || isFailed
                ? `Manage download for ${what}`
                : `Download ${what} (${targetLabel} ${formatLabel})`
          }
        >
          <Icon name={mainIcon} size={16} />
          {mainLabel}
        </button>
        <button
          type="button"
          className={`btn glass${btnSz} dl-split-caret ${open ? "on" : ""}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={`Download options for ${what}`}
          title="Download quality, format, and servers"
          onClick={() => setOpen((x) => !x)}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

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
                onClick={() => void openDownloadsFolder(saved?.filePath)}
                title={root}
              >
                Open folder
              </button>
            )}
          </div>

          <div className="dl-qbar" aria-label="Download quality and format">
            <div className="dl-qbar-row">
              <span className="dl-qbar-lbl">Quality</span>
              <div className="dl-qbar-pills">
                {[2160, 1080, 720, 480].map((q) => (
                  <button
                    key={q}
                    type="button"
                    className={`chip ${targetQuality === q ? "on" : ""}`}
                    onClick={() => dlPrefs.setQuality(q)}
                    title={`Target ${q >= 2160 ? "4K" : `${q}p`}`}
                  >
                    {q >= 2160 ? "4K" : `${q}p`}
                  </button>
                ))}
              </div>
            </div>
            <div className="dl-qbar-row">
              <span className="dl-qbar-lbl">Format</span>
              <div className="dl-qbar-pills">
                {(["mp4", "mkv"] as DownloadFormat[]).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    className={`chip ${targetFormat === fmt ? "on" : ""}`}
                    onClick={() => dlPrefs.setFormat(fmt)}
                    title={
                      fmt === "mkv"
                        ? "MKV — Matroska with embedded soft subtitles"
                        : "MP4 — Universal instant playback with stereo AAC audio"
                    }
                  >
                    {fmt === "mp4" ? "MP4 · Instant" : "MKV · Soft subs"}
                  </button>
                ))}
              </div>
            </div>
            <div className="dl-qbar-row">
              <span className="dl-qbar-lbl">Fallback</span>
              <div className="dl-qbar-pills">
                {(
                  [
                    ["ask", "Ask me"],
                    ["strict", "Exact only"],
                    ["best", "Best available"],
                  ] as [DownloadQualityPolicy, string][]
                ).map(([pid, label]) => (
                  <button
                    key={pid}
                    type="button"
                    className={`chip ${dlPrefs.policy === pid ? "on" : ""}`}
                    onClick={() => dlPrefs.setPolicy(pid)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {saved && (
            <div className="dl-saved-card">
              <div>
                <strong>
                  Saved offline · {savedQLabel ?? "HD"} {savedFmtLabel}
                  {saved.qualityVerified ? " ✓" : ""}
                </strong>
                <small>
                  {[
                    saved.providerName,
                    saved.videoCodec,
                    fmtSize(saved.fileSize),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </div>
              {confirmDelete ? (
                <div className="dl-saved-confirm">
                  <button
                    type="button"
                    className="chip danger"
                    onClick={() => {
                      setConfirmDelete(false);
                      void removeDownloadedItem(saved.id, true);
                    }}
                  >
                    Delete file
                  </button>
                  <button type="button" className="chip" onClick={() => setConfirmDelete(false)}>
                    Keep
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="chip danger"
                  title="Remove downloaded copy from disk"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Icon name="trash" size={12} /> Remove
                </button>
              )}
            </div>
          )}

          {activeJob && (isBusy || isPaused || isAwaiting || isFailed) && (
            <div className={`dl-active-card ${isFailed ? "failed" : ""} ${isAwaiting ? "awaiting" : ""}`}>
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
                <b>{isAwaiting ? availQStr : `${Math.round(activeJob.percent)}%`}</b>
              </div>
              <div className="dl-active-badges">
                {activeQ && (
                  <span className={`dlq-badge-q ${activeQ.verified ? "verified" : ""}`} title={activeQ.title}>
                    {activeQ.label}
                    {activeQ.verified ? " ✓" : ""}
                  </span>
                )}
                {activeJob.videoCodec && <span className="dlq-badge-dim">{activeJob.videoCodec}</span>}
                <span className="dlq-badge-dim">{formatDownloadTransferLabel(activeJob)}</span>
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
              {!isAwaiting && (
                <div className="dl-bar">
                  <i style={{ transform: `scaleX(${Math.max(0.02, activeJob.percent / 100)})` }} />
                </div>
              )}
              <div className="dl-active-acts">
                {isAwaiting ? (
                  <button
                    type="button"
                    className="btn play xs"
                    onClick={() => {
                      setOpen(false);
                      void resolveQualityMismatch([activeJob.id], "accept", availQNum);
                    }}
                  >
                    <Icon name="download" size={12} /> Download {availQStr}
                  </button>
                ) : isBusy ? (
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
                  <Icon name="shuffle" size={12} /> {activeSwitching ? "Switching…" : "Next server"}
                </button>
                <button
                  type="button"
                  className="chip danger"
                  onClick={() =>
                    void (isAwaiting ? resolveQualityMismatch([activeJob.id], "cancel") : cancelDownload(activeJob.id))
                  }
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!isBusy && !isPaused && !isAwaiting && !isFailed && !saved && (
            ranked.length > 0 ? (
              <button type="button" className="dl-quick-cta" onClick={triggerQuickDownload}>
                <Icon name="download" size={14} />
                <span>
                  <strong>Download now · {ranked[0].providerName}</strong>
                  <small>
                    {targetLabel} · {formatLabel}
                    {ranked.length > 1
                      ? ` · ${Math.min(6, ranked.length - 1)} backup server${Math.min(6, ranked.length - 1) === 1 ? "" : "s"}`
                      : ""}
                  </small>
                </span>
              </button>
            ) : (
              <div className="dl-pop-empty">
                {snap?.busy
                  ? "Scanning servers for downloadable streams…"
                  : "No direct or HLS download streams verified yet. Try again or check Servers."}
              </div>
            )
          )}

          {ranked.length > 0 && (
            <div className="dl-servers-toggle">
              <button
                type="button"
                className="link-btn dl-servers-btn"
                aria-expanded={showServers}
                onClick={() => setShowServers((s) => !s)}
              >
                <span>{showServers ? "Hide server list" : `Choose server manually (${ranked.length})`}</span>
                <svg className={showServers ? "rot" : ""} viewBox="0 0 12 12" width="11" height="11" aria-hidden>
                  <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {showServers && (
                <div className="dl-pop-list">
                  {ranked.map((c) => {
                    const q = qualityLabel(c);
                    const knownQ = c.probe?.quality ?? c.quality;
                    const belowTarget = knownQ != null && knownQ > 0 && knownQ < targetQuality;
                    const audio = audioLabel(c);
                    const fmt = downloadFormatLabel(c, targetFormat);
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
                            preferredQuality: targetQuality,
                            preferredFormat: targetFormat,
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
                          {q && <b className={belowTarget ? "dl-opt-warn" : undefined} title={belowTarget ? `Below ${targetLabel} target` : undefined}>{q}</b>}
                          {belowTarget && <b className="dl-opt-warn">low res</b>}
                          {audio && <b>{audio}</b>}
                        </span>
                        <span className="dl-opt-act">
                          {rowBusy ? `${Math.round(rowJob.percent)}%` : <Icon name="download" size={14} />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

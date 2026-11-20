import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { downloadFormatLabel, rankDownloadOptions } from "../lib/downloadRank";
import {
  cancelDownload,
  findDownloadedEntries,
  findDownloadJob,
  openDownloadsFolder,
  pauseDownload,
  removeDownloadedItem,
  resumeDownload,
  startDownload,
  useDownloads,
} from "../lib/downloads";
import { fmtSize } from "../lib/library";
import { useSettings } from "../lib/settings";
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
  const { jobs, items, root } = useDownloads();
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
  const pct = activeJob ? Math.round(activeJob.percent) : 0;

  const btnLabel = isBusy
    ? activeJob.status === "remuxing"
      ? "Saving…"
      : activeJob.status === "queued"
        ? "Queued"
        : `${pct}%`
    : isPaused
      ? `Paused ${pct}%`
      : saved
        ? "Saved"
        : "Download";

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
        <Icon name={saved && !isBusy && !isPaused ? "check" : isPaused ? "pause" : "download"} size={17} />
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

          {saved && (
            <div className="dl-saved-card">
              <div>
                <strong>Saved for offline playback</strong>
                <small>
                  {saved.providerName} · {saved.quality ? `${saved.quality}p · ` : ""}
                  {fmtSize(saved.fileSize)}
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

          {activeJob && (isBusy || isPaused || activeJob.status === "failed") && (
            <div className="dl-active-card">
              <div className="dl-active-top">
                <span>
                  <b>{activeJob.providerName}</b>
                  <small>{activeJob.error || activeJob.stage || activeJob.status}</small>
                </span>
                <b>{Math.round(activeJob.percent)}%</b>
              </div>
              <div className="dl-bar">
                <i style={{ transform: `scaleX(${Math.max(0.02, activeJob.percent / 100)})` }} />
              </div>
              <div className="dl-active-acts">
                {isBusy ? (
                  <button type="button" className="chip" onClick={() => void pauseDownload(activeJob.id)}>
                    <Icon name="pause" size={12} /> Pause
                  </button>
                ) : (
                  <button type="button" className="chip" onClick={() => void resumeDownload(activeJob.id)}>
                    <Icon name="play" size={12} /> {activeJob.status === "failed" ? "Retry" : "Resume"}
                  </button>
                )}
                <button type="button" className="chip" onClick={() => void cancelDownload(activeJob.id)}>
                  Cancel
                </button>
              </div>
            </div>
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
                      void startDownload(req, c, detail, episodeTitle);
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

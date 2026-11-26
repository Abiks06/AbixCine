import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  resolveBatchQualityPrompt,
  useBatchDownloads,
  useBatchQualityPrompt,
} from "../lib/batchDownload";
import { formatResolution } from "../lib/downloadRank";
import {
  resolveQualityMismatch,
  useDownloads,
  type DownloadJob,
} from "../lib/downloads";
import {
  normalizeDownloadQualityPolicy,
  updateSettings,
  useSettings,
  type DownloadQualityPolicy,
} from "../lib/settings";
import { useModalFocusTrap } from "../lib/useModalFocusTrap";
import { Icon } from "./Icon";

const POLICY_OPTIONS: { id: DownloadQualityPolicy; label: string; hint: string }[] = [
  { id: "ask", label: "Ask me", hint: "Hold lower quality & ask first" },
  { id: "strict", label: "Exact only", hint: "Never download lower quality" },
  { id: "best", label: "Best available", hint: "Download closest automatically" },
];

let manualOpenSeq = 0;
const reviewListeners = new Set<() => void>();

/** Explicitly open the quality review dialog for any held awaitingQuality jobs. */
export function openQualityReviewModal(): void {
  manualOpenSeq += 1;
  reviewListeners.forEach((fn) => fn());
}

function useManualReviewSeq(): number {
  return useSyncExternalStore(
    (cb) => {
      reviewListeners.add(cb);
      return () => reviewListeners.delete(cb);
    },
    () => manualOpenSeq,
  );
}

function epLabel(j: DownloadJob): string {
  if (j.isFilm || j.episode == null) return j.title;
  return `S${String(j.season ?? 1).padStart(2, "0")}E${String(j.episode).padStart(2, "0")}`;
}

export function DownloadQualityModal() {
  const s = useSettings();
  const policy = normalizeDownloadQualityPolicy(s.downloadQualityPolicy);
  const { jobs } = useDownloads();
  const batch = useBatchDownloads();
  const batchPrompt = useBatchQualityPrompt();
  const reviewSeq = useManualReviewSeq();

  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [debouncedReady, setDebouncedReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  const awaitingAll = useMemo(
    () => jobs.filter((j) => j.status === "awaitingQuality"),
    [jobs],
  );

  // Clear dismissals when user explicitly requests review or when held jobs disappear.
  useEffect(() => {
    if (reviewSeq > 0) {
      setDismissedIds(new Set());
      setDebouncedReady(true);
    }
  }, [reviewSeq]);

  useEffect(() => {
    const activeIds = new Set(awaitingAll.map((j) => j.id));
    setDismissedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (activeIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [awaitingAll]);

  const unacknowledged = useMemo(
    () => awaitingAll.filter((j) => !dismissedIds.has(j.id)),
    [awaitingAll, dismissedIds],
  );

  // Group multi-episode holds briefly before prompting so users get one unified dialog.
  useEffect(() => {
    if (unacknowledged.length === 0) {
      setDebouncedReady(false);
      return;
    }
    const delay = batch.active ? 900 : 350;
    const t = window.setTimeout(() => setDebouncedReady(true), delay);
    return () => window.clearTimeout(t);
  }, [unacknowledged.length, batch.active]);

  const activeGroup = useMemo(() => {
    if (!debouncedReady || unacknowledged.length === 0) return null;
    const first = unacknowledged[0];
    const gKey = first.isFilm ? first.id : `${first.canonicalKey}|${first.season ?? 1}`;
    const groupJobs = unacknowledged
      .filter((j) => (first.isFilm ? j.id === first.id : `${j.canonicalKey}|${j.season ?? 1}` === gKey))
      .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
    return { first, groupJobs };
  }, [debouncedReady, unacknowledged]);

  useModalFocusTrap(Boolean(batchPrompt || activeGroup), modalRef);

  useEffect(() => {
    if (!activeGroup || batchPrompt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || busy) return;
      e.preventDefault();
      e.stopPropagation();
      setDismissedIds((prev) => {
        const next = new Set(prev);
        activeGroup.groupJobs.forEach((j) => next.add(j.id));
        return next;
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [batchPrompt, activeGroup, busy]);

  if (batchPrompt) {
    const targetStr = formatResolution(batchPrompt.targetQuality) || `${batchPrompt.targetQuality}p`;
    const bestStr = formatResolution(batchPrompt.bestQuality) || `${batchPrompt.bestQuality}p`;
    return (
      <div className="dl-modal-scrim" role="dialog" aria-modal="true" aria-labelledby="dl-qp-title">
        <div className="dl-modal dl-qmodal glass" ref={modalRef} tabIndex={-1}>
          <div className="dl-modal-head">
            <span className="dl-modal-ic warn" aria-hidden>
              <Icon name="info" size={20} />
            </span>
            <div>
              <p className="overline">Quality consistency check</p>
              <h2 id="dl-qp-title">{targetStr} unavailable for Season {batchPrompt.season}</h2>
            </div>
            <button
              type="button"
              className="icon-btn"
              title="Cancel season download"
              aria-label="Cancel season download"
              onClick={() => resolveBatchQualityPrompt("cancel")}
            >
              <Icon name="x" size={16} />
            </button>
          </div>

          <p className="dl-modal-copy">
            No server for <strong>{batchPrompt.title}</strong> (S{batchPrompt.season} E{batchPrompt.episodeNumber}
            {batchPrompt.episodeTitle ? ` · ${batchPrompt.episodeTitle}` : ""}) provides{" "}
            <strong>{targetStr}</strong>. The highest verified source ({batchPrompt.providerName}) is{" "}
            <strong>{bestStr}</strong>
            {batchPrompt.remainingEpisodes > 0
              ? `, with ${batchPrompt.remainingEpisodes} more episode${batchPrompt.remainingEpisodes === 1 ? "" : "s"} queued.`
              : "."}
          </p>

          <div className="dl-qmodal-policy">
            <span>Default behavior</span>
            <div className="dl-qmodal-policy-tabs" role="group" aria-label="If target quality unavailable">
              {POLICY_OPTIONS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`chip ${policy === p.id ? "on" : ""}`}
                  aria-pressed={policy === p.id}
                  title={p.hint}
                  onClick={() => updateSettings({ downloadQualityPolicy: p.id })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="dl-qmodal-acts">
            <button
              type="button"
              className="btn play sm"
              onClick={() => resolveBatchQualityPrompt("switch_season")}
            >
              <Icon name="download" size={15} />
              Download all S{batchPrompt.season} in {bestStr} ({batchPrompt.totalEpisodes} eps)
            </button>
            <button
              type="button"
              className="btn glass sm"
              onClick={() => resolveBatchQualityPrompt("accept_once")}
            >
              Use {bestStr} for E{batchPrompt.episodeNumber} only
            </button>
            <button
              type="button"
              className="btn glass sm"
              onClick={() => resolveBatchQualityPrompt("skip_keep_target")}
            >
              Skip E{batchPrompt.episodeNumber}, keep {targetStr} for rest
            </button>
            <button
              type="button"
              className="chip danger"
              onClick={() => resolveBatchQualityPrompt("cancel")}
            >
              Cancel season
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!activeGroup) return null;

  const { first, groupJobs } = activeGroup;
  const ids = groupJobs.map((j) => j.id);
  const targetQ = first.preferredQuality ?? 1080;
  const targetStr = formatResolution(targetQ) || `${targetQ}p`;
  const availHeights = groupJobs
    .map((j) => j.availableQuality ?? j.resolvedQuality ?? j.quality)
    .filter((q): q is number => q != null && q > 0);
  const uniqueHeights = [...new Set(availHeights)].sort((a, b) => a - b);
  const minAvailQ = uniqueHeights[0];
  const minAvailStr = formatResolution(minAvailQ);
  const allSameHeight = uniqueHeights.length === 1;

  const dismissGroup = () => {
    setDismissedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const runAction = async (action: "accept" | "cancel", newQ?: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await resolveQualityMismatch(ids, action, newQ);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="dl-modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dl-qm-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) dismissGroup();
      }}
    >
      <div className="dl-modal dl-qmodal glass" ref={modalRef} tabIndex={-1}>
        <div className="dl-modal-head">
          <span className="dl-modal-ic warn" aria-hidden>
            <Icon name="info" size={20} />
          </span>
          <div>
            <p className="overline">Requested {targetStr} not available</p>
            <h2 id="dl-qm-title">
              {first.title}
              {!first.isFilm && first.season != null ? ` · Season ${first.season}` : ""}
            </h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Decide later"
            disabled={busy}
            onClick={dismissGroup}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <p className="dl-modal-copy">
          Checked all available servers for {groupJobs.length === 1 ? epLabel(first) : `${groupJobs.length} episodes`},
          but none reached <strong>{targetStr}</strong>. Choose whether to download consistently at a lower resolution or cancel.
        </p>

        <div className="dl-qmodal-list">
          {groupJobs.slice(0, 6).map((j) => {
            const avail = formatResolution(j.availableQuality ?? j.resolvedQuality ?? j.quality) || "Unknown";
            return (
              <div key={j.id} className="dl-qmodal-row">
                <strong>{epLabel(j)}</strong>
                <span>{j.providerName}</span>
                <b>Best: {avail}</b>
              </div>
            );
          })}
          {groupJobs.length > 6 && (
            <div className="dl-qmodal-more">+{groupJobs.length - 6} more episode{groupJobs.length - 6 === 1 ? "" : "s"}</div>
          )}
        </div>

        <div className="dl-qmodal-policy">
          <span>Default behavior</span>
          <div className="dl-qmodal-policy-tabs" role="group" aria-label="If target quality unavailable">
            {POLICY_OPTIONS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`chip ${policy === p.id ? "on" : ""}`}
                aria-pressed={policy === p.id}
                title={p.hint}
                onClick={() => updateSettings({ downloadQualityPolicy: p.id })}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="dl-qmodal-acts">
          {minAvailQ != null && (
            <button
              type="button"
              className="btn play sm"
              disabled={busy}
              onClick={() => void runAction("accept", minAvailQ)}
            >
              <Icon name="download" size={15} />
              {groupJobs.length > 1
                ? allSameHeight
                  ? `Download all ${groupJobs.length} in ${minAvailStr}`
                  : `Download all in consistent ${minAvailStr}`
                : `Download in ${minAvailStr}`}
            </button>
          )}
          {groupJobs.length > 1 && !allSameHeight && (
            <button
              type="button"
              className="btn glass sm"
              disabled={busy}
              onClick={() => void runAction("accept")}
            >
              Use highest per episode
            </button>
          )}
          <button
            type="button"
            className="btn glass sm"
            disabled={busy}
            onClick={dismissGroup}
          >
            Decide later
          </button>
          <button
            type="button"
            className="chip danger"
            disabled={busy}
            onClick={() => void runAction("cancel")}
          >
            <Icon name="x" size={12} /> Cancel {groupJobs.length > 1 ? `(${groupJobs.length})` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

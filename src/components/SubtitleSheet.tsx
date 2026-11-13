import { memo, useEffect, useState } from "react";
import {
  COMMON_SUB_LANGS,
  langBase,
  langLabel,
  type CueSize,
  type SubPref,
  type SubtitleCue,
} from "../lib/subtitles";
import type { OnlineSubtitleResult } from "../lib/subtitleProviders";
import type { SubtitleFormat, SubtitleSource } from "../sources/types";
import { Icon } from "./Icon";

export type SubTrackOrigin = SubtitleSource | "hls" | "native";

export interface UnifiedSubTrack {
  id: string;
  label: string;
  lang: string;
  origin: SubTrackOrigin;
  format?: SubtitleFormat;
  isDefault?: boolean;
  isForced?: boolean;
  isHearingImpaired?: boolean;
  url?: string;
  raw?: string;
  streamIndex?: number;
  hlsIndex?: number;
  nativeTrack?: TextTrack;
  provider?: "wyzie" | "opensubtitles";
  release?: string;
  cues?: SubtitleCue[];
  loading?: boolean;
  error?: string;
}

export interface SubtitleSheetProps {
  isEmbed: boolean;
  tracks: readonly UnifiedSubTrack[];
  selectedId: string | null;
  secondaryId: string | null;
  onSelectPrimary: (id: string | null) => void;
  onSelectSecondary: (id: string | null) => void;
  offset: number;
  onNudge: (delta: number) => void;
  onResetOffset: () => void;
  onUploadFiles: (files: FileList | File[]) => void;
  subPref: SubPref;
  onPatchPref: (patch: Partial<SubPref>) => void;
  media?: { title?: string; year?: number; kind?: string; tmdbId?: number; imdbId?: string };
  season?: number;
  episode?: number;
  canSaveSidecar: boolean;
  onSaveSidecar: (track: UnifiedSubTrack) => void;
  savingTrackId: string | null;
  savedTrackIds: ReadonlySet<string>;
  onlineResults: readonly OnlineSubtitleResult[];
  onlineLoading: boolean;
  onlineSearched: boolean;
  onlineError: string | null;
  onSearchOnline: (title: string, lang: string) => void;
  onLoadOnline: (res: OnlineSubtitleResult, asSecondary: boolean) => void;
  loadingOnlineId: string | null;
  loadedOnlineMap: ReadonlyMap<string, string>;
}

const QUICK_SIZES: readonly { id: CueSize; label: string }[] = [
  { id: "xs", label: "XS" },
  { id: "s", label: "S" },
  { id: "m", label: "M" },
  { id: "l", label: "L" },
  { id: "xl", label: "XL" },
];

const ORIGIN_LABELS: Record<SubTrackOrigin, string> = {
  embedded: "MKV",
  sidecar: "Sidecar",
  stream: "Stream",
  hls: "HLS",
  native: "Media",
  online: "Online",
  user: "File",
};

const PROVIDER_LABELS: Record<OnlineSubtitleResult["provider"], string> = {
  wyzie: "Wyzie",
  opensubtitles: "OpenSubs",
};

export const SubtitleSheet = memo(function SubtitleSheet({
  isEmbed,
  tracks,
  selectedId,
  secondaryId,
  onSelectPrimary,
  onSelectSecondary,
  offset,
  onNudge,
  onResetOffset,
  onUploadFiles,
  subPref,
  onPatchPref,
  media,
  season,
  episode,
  canSaveSidecar,
  onSaveSidecar,
  savingTrackId,
  savedTrackIds,
  onlineResults,
  onlineLoading,
  onlineSearched,
  onlineError,
  onSearchOnline,
  onLoadOnline,
  loadingOnlineId,
  loadedOnlineMap,
}: SubtitleSheetProps) {
  const [searchTitle, setSearchTitle] = useState(media?.title ?? "");
  const [searchLang, setSearchLang] = useState(subPref.lang || "en");

  useEffect(() => {
    setSearchTitle(media?.title ?? "");
  }, [media?.title]);

  useEffect(() => {
    if (subPref.lang) setSearchLang(subPref.lang);
  }, [subPref.lang]);

  if (isEmbed) {
    return (
      <div className="ps-section">
        <div className="ps-block">
          <div className="ps-label">Subtitles</div>
          <p className="ps-note">This server draws its own subtitles inside its player. Use the CC button inside the stream.</p>
        </div>
      </div>
    );
  }

  const epTag =
    episode != null
      ? `${season != null ? `S${String(season).padStart(2, "0")}` : ""}E${String(episode).padStart(2, "0")}`
      : null;

  const secondaryTrack = tracks.find((t) => t.id === secondaryId) ?? null;
  const fallbackDualCandidate =
    tracks.find(
      (t) =>
        t.id !== selectedId &&
        subPref.secondaryLang &&
        langBase(t.lang) === langBase(subPref.secondaryLang),
    ) ?? tracks.find((t) => t.id !== selectedId);

  return (
    <div className="ps-section">
      {/* Tracks */}
      <div className="ps-block">
        <div className="sub-sheet-head-row">
          <div className="ps-label">
            Tracks <kbd>C</kbd> <kbd>⇧C</kbd>
          </div>
          {secondaryTrack && (
            <button
              type="button"
              className="sub-mini-btn on"
              onClick={() => onSelectSecondary(null)}
              title="Turn off dual subtitle"
            >
              <Icon name="dual" size={12} /> Dual: {langBase(secondaryTrack.lang) !== "und" ? langBase(secondaryTrack.lang).toUpperCase() : "On"} ×
            </button>
          )}
        </div>

        <div className="opt-list">
          <button
            type="button"
            className={`opt ${!selectedId ? "on" : ""}`}
            onClick={() => {
              onSelectPrimary(null);
              if (secondaryId) onSelectSecondary(null);
            }}
          >
            <span>Off</span>
            {secondaryId && <small>Clears dual</small>}
          </button>

          {tracks.map((t) => {
            const isPrim = selectedId === t.id;
            const isDual = secondaryId === t.id;
            const base = langBase(t.lang);
            const saved = savedTrackIds.has(t.id);
            const saving = savingTrackId === t.id;

            return (
              <div key={t.id} className={`sub-track-row ${isPrim ? "on" : ""} ${isDual ? "dual" : ""}`}>
                <button
                  type="button"
                  className="sub-track-pick"
                  onClick={() => onSelectPrimary(t.id)}
                  title={t.release ?? t.label}
                >
                  <span className="sub-track-title">{t.label}</span>
                  <span className="sub-track-meta">
                    {base !== "und" && <span className="sub-tag">{base}</span>}
                    {t.format && <span className="sub-tag fmt">{t.format}</span>}
                    <span className="sub-tag">{ORIGIN_LABELS[t.origin]}</span>
                    {t.isHearingImpaired && <span className="sub-tag hi">SDH</span>}
                    {t.isForced && <span className="sub-tag warn">Forced</span>}
                    {t.isDefault && <span className="sub-tag ok">Default</span>}
                    {t.error && <span className="sub-tag warn" title={t.error}>Error</span>}
                  </span>
                </button>

                {t.loading && <span className="mini-spin" aria-label="Loading subtitle" />}

                {canSaveSidecar && t.origin === "online" && (
                  <button
                    type="button"
                    className={`sub-mini-btn ${saved ? "on" : ""}`}
                    disabled={saving || t.loading}
                    onClick={() => onSaveSidecar(t)}
                    title={saved ? "Saved next to video" : "Save next to video"}
                  >
                    <Icon name={saved ? "check" : "download"} size={12} />
                    {saving ? "…" : saved ? "Saved" : "Save"}
                  </button>
                )}

                <button
                  type="button"
                  className={`sub-mini-btn ${isDual ? "on" : ""}`}
                  disabled={isPrim}
                  onClick={() => onSelectSecondary(isDual ? null : t.id)}
                  title={isPrim ? "Already selected as primary" : isDual ? "Remove secondary subtitle" : "Show as secondary dual subtitle"}
                >
                  {isDual ? "Dual" : "+ Dual"}
                </button>
              </div>
            );
          })}
        </div>

        <div className="sub-actions-row">
          <label className="btn glass sm sub-add">
            <Icon name="upload" size={14} /> Load file (.srt / .vtt / .ass)
            <input
              type="file"
              accept=".srt,.vtt,.ass,.ssa,text/vtt,application/x-subrip,text/x-ssa"
              multiple
              onChange={(e) => {
                if (e.currentTarget.files?.length) onUploadFiles(e.currentTarget.files);
                e.currentTarget.value = "";
              }}
            />
          </label>
          <span className="ps-note">or drop onto player</span>
        </div>
      </div>

      {/* Timing Offset — works for ALL tracks */}
      {(selectedId || secondaryId) && (
        <div className="ps-block">
          <div className="sub-sheet-head-row">
            <div className="ps-label">
              <Icon name="clock" size={12} /> Timing <kbd>[</kbd><kbd>]</kbd>
            </div>
            <span className="ps-sub">
              {offset === 0 ? "In sync" : `${offset > 0 ? "+" : ""}${offset.toFixed(1)}s`}
            </span>
          </div>
          <div className="sub-timing-grid">
            <button type="button" onClick={() => onNudge(-1)}>−1s</button>
            <button type="button" onClick={() => onNudge(-0.5)}>−0.5</button>
            <button type="button" onClick={() => onNudge(-0.1)}>−0.1</button>
            <button type="button" className={offset === 0 ? "on" : ""} onClick={onResetOffset}>
              Reset
            </button>
            <button type="button" onClick={() => onNudge(0.1)}>+0.1</button>
            <button type="button" onClick={() => onNudge(0.5)}>+0.5</button>
            <button type="button" onClick={() => onNudge(1)}>+1s</button>
          </div>
        </div>
      )}

      {/* Online Subtitle Search */}
      <div className="ps-block">
        <div className="sub-sheet-head-row">
          <div className="ps-label">
            <Icon name="globe" size={12} /> Search online
          </div>
          {epTag && <span className="sub-tag">{epTag}</span>}
        </div>

        <form
          className="sub-online-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSearchOnline(searchTitle, searchLang);
          }}
        >
          <input
            type="text"
            value={searchTitle}
            onChange={(e) => setSearchTitle(e.target.value)}
            placeholder="Title to search…"
            aria-label="Subtitle search title"
          />
          <select
            className="sub-select"
            value={searchLang}
            onChange={(e) => setSearchLang(e.target.value)}
            aria-label="Online subtitle language"
          >
            {searchLang && !COMMON_SUB_LANGS.some((l) => l.code === searchLang) && (
              <option value={searchLang}>{langLabel(searchLang)}</option>
            )}
            {COMMON_SUB_LANGS.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
          <button type="submit" className="btn btn-glass sm" disabled={onlineLoading} aria-label="Search subtitles">
            {onlineLoading ? <span className="mini-spin" /> : <Icon name="search" size={14} />}
          </button>
        </form>

        {onlineError && <p className="ps-note" role="status">{onlineError}</p>}
        {onlineSearched && !onlineLoading && !onlineError && onlineResults.length === 0 && (
          <p className="ps-note">No online subtitles matched that search. Try another language or title.</p>
        )}

        {onlineResults.length > 0 && (
          <div className="sub-online-list">
            {onlineResults.map((r) => {
              const busy = loadingOnlineId === r.id;
              const loadedTrackId = loadedOnlineMap.get(r.id);
              const loadedTrack = loadedTrackId ? tracks.find((t) => t.id === loadedTrackId) : undefined;
              const saved = loadedTrack ? savedTrackIds.has(loadedTrack.id) : false;

              return (
                <div key={r.id} className={`sub-online-item ${loadedTrack ? "loaded" : ""}`}>
                  <div className="sub-online-top">
                    <span className="sub-online-rel" title={r.release || r.langName}>
                      {r.release || `${r.langName} subtitle`}
                    </span>
                    <span className="sub-tag">{r.langName}</span>
                  </div>
                  <div className="sub-online-foot">
                    <span className="sub-track-meta">
                      <span className="sub-tag fmt">{r.format}</span>
                      <span className="sub-tag">{PROVIDER_LABELS[r.provider]}</span>
                      {r.hearingImpaired && <span className="sub-tag hi">SDH</span>}
                      {r.forced && <span className="sub-tag warn">Forced</span>}
                      {r.downloads != null && r.downloads > 0 && (
                        <span className="sub-tag">{r.downloads.toLocaleString()} dl</span>
                      )}
                    </span>
                    <span className="sub-online-btns">
                      {canSaveSidecar && loadedTrack && (
                        <button
                          type="button"
                          className={`sub-mini-btn ${saved ? "on" : ""}`}
                          disabled={savingTrackId === loadedTrack.id}
                          onClick={() => onSaveSidecar(loadedTrack)}
                          title="Save next to video"
                        >
                          <Icon name={saved ? "check" : "download"} size={12} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="sub-mini-btn"
                        disabled={busy}
                        onClick={() => onLoadOnline(r, false)}
                      >
                        {busy ? <span className="mini-spin" /> : loadedTrack && selectedId === loadedTrack.id ? "Active" : "Load"}
                      </button>
                      <button
                        type="button"
                        className="sub-mini-btn"
                        disabled={busy}
                        onClick={() => onLoadOnline(r, true)}
                      >
                        + Dual
                      </button>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Quick Appearance */}
      <div className="ps-block">
        <div className="ps-label">
          <Icon name="sliders" size={12} /> Appearance
        </div>
        <div className="sub-quick-block">
          <div className="seg3">
            {QUICK_SIZES.map((sz) => (
              <button
                key={sz.id}
                type="button"
                className={subPref.size === sz.id ? "on" : ""}
                onClick={() => onPatchPref({ size: sz.id })}
              >
                {sz.label}
              </button>
            ))}
          </div>

          <label className="sub-slider-row">
            <span>Position</span>
            <input
              type="range"
              min={2}
              max={45}
              step={1}
              value={subPref.bottomPct}
              onChange={(e) => onPatchPref({ bottomPct: Number(e.target.value) })}
              aria-label="Subtitle bottom offset"
            />
            <code>{subPref.bottomPct}%</code>
          </label>

          <div className="sub-sheet-head-row">
            <span className="ps-note">Dual subtitles</span>
            <button
              type="button"
              className={`sub-mini-btn ${secondaryTrack ? "on" : ""}`}
              disabled={!secondaryTrack && !fallbackDualCandidate}
              onClick={() => {
                if (secondaryTrack) onSelectSecondary(null);
                else if (fallbackDualCandidate) onSelectSecondary(fallbackDualCandidate.id);
              }}
            >
              <Icon name="dual" size={12} />
              {secondaryTrack ? "Turn off dual" : fallbackDualCandidate ? `Enable (${langBase(fallbackDualCandidate.lang) !== "und" ? langBase(fallbackDualCandidate.lang).toUpperCase() : "2nd"})` : "Need 2+ tracks"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

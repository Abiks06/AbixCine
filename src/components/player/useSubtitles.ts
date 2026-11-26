/**
 * Subtitles for the player: every track source (stream, native, embedded, files you drop,
 * online search), the primary + dual selection with per-show memory, timing offsets, and the
 * cue engine that drives the overlay. Also owns the audio-track list state it shares with
 * the stream attach code. Lifted verbatim out of Player.tsx (PERF-06): same hooks, same order.
 */
import type Hls from "hls.js";
import type shaka from "shaka-player";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createHlsSideLoader } from "../../lib/hlsSideSubs";
import { DashCueCollector } from "../../lib/dashCues";
import { SUB_PREF_EVENT, activeCuesAt, nextCueBoundaryAfter, cuesToVtt, decodeSubtitle, langBase, loadSubPref, loadSubTrackMemory, normalizeSubPref, parseSubtitles, pickBestSubtitleIndex, saveSubPref, saveSubTrackMemory, shouldAutoEnableSubtitles, type SubPref, type SubtitleCue } from "../../lib/subtitles";
import {
  fetchAndParseSubtitle,
  searchOnlineSubtitles,
  type OnlineSubtitleResult,
} from "../../lib/subtitleProviders";
import { normalizeMatchTitle } from "../../sources/titleMatch";
import { getSettings, updateSettings, type Audio } from "../../lib/settings";
import { refreshDownloads } from "../../lib/downloads";
import type { StreamCandidate, SubtitleFormat } from "../../sources/types";
import { type UnifiedSubTrack } from "../SubtitleSheet";
import { SUB_FILE_EXT_RX, cueSignature, inferUserSubLang, textTrackToCues, type ExtractedSubtitleResult, type TrackCueCache, type EpisodeNav } from "./shared";
import type { MutableRefObject, RefObject } from "react";
import type { PlayerMedia } from "./shared";

export interface SubtitlesContext {
  media: PlayerMedia | undefined;
  flash: (msg: string) => void;
  cur: StreamCandidate | undefined;
  mountedRef: MutableRefObject<boolean>;
  isEmbed: boolean;
  title: string;
  originalLanguage: string | undefined;
  video: RefObject<HTMLVideoElement>;
  hlsRef: MutableRefObject<Hls | null>;
  curRef: MutableRefObject<StreamCandidate | undefined>;
  playing: boolean;
  episodes: EpisodeNav | undefined;
  dashSubIdRef: MutableRefObject<string | null>;
  audio: Audio | undefined;
  shakaRef: MutableRefObject<shaka.Player | null>;
  season: number | undefined;
  initPtsRef: MutableRefObject<number | null>;
  episode: number | undefined;
  dashCollectorRef: MutableRefObject<DashCueCollector | null>;
  activeKey: string;
}

export function useSubtitles(ctx: SubtitlesContext) {
  const { media, flash, cur, mountedRef, isEmbed, title, originalLanguage, video, hlsRef, curRef, playing, episodes, dashSubIdRef, audio, shakaRef, season, initPtsRef, episode, dashCollectorRef, activeKey } = ctx;
  /* -------------------------------------------------------------- subtitles */

  const [pref, setPref] = useState<SubPref>(() => loadSubPref());
  const prefRef = useRef(pref);
  prefRef.current = pref;

  const patchPref = useCallback((patch: Partial<SubPref>) => {
    const syncedPatch: Partial<SubPref> =
      patch.on !== undefined && patch.mode === undefined
        ? { ...patch, mode: patch.on ? (prefRef.current.mode === "off" ? "on" : prefRef.current.mode) : "off" }
        : patch;
    const next = normalizeSubPref({ ...prefRef.current, ...syncedPatch });
    prefRef.current = next;
    setPref(next);
    saveSubPref(next);
    updateSettings({ subtitlePref: next });
  }, []);

  useEffect(() => {
    const syncFromStorage = () => setPref(loadSubPref());
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === "abx.subs.v1") syncFromStorage();
    };
    window.addEventListener(SUB_PREF_EVENT, syncFromStorage);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SUB_PREF_EVENT, syncFromStorage);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const epSeason = season ?? episodes?.season;
  const epNumber = episode ?? episodes?.episode;
  const epRef = useRef<{ season?: number; episode?: number }>({});
  epRef.current = { season: epSeason ?? undefined, episode: epNumber ?? undefined };
  const subMemoryKey = useMemo(() => {
    const base =
      media?.key ||
      (media?.tmdbId ? `tmdb:${media.kind ?? "media"}:${media.tmdbId}` : "") ||
      (media?.imdbId ? `imdb:${media.imdbId}` : "") ||
      cur?.localPath ||
      title;
    if (!base) return "";
    return epNumber != null ? `${base}:s${epSeason ?? 0}e${epNumber}` : base;
  }, [media?.key, media?.tmdbId, media?.imdbId, media?.kind, cur?.localPath, title, epSeason, epNumber]);
  const subMemoryKeyRef = useRef(subMemoryKey);
  subMemoryKeyRef.current = subMemoryKey;

  const persistTrackMemory = useCallback((entry: {
    selectedLang?: string;
    selectedLabel?: string;
    secondaryLang?: string;
    offsetSec?: number;
    secondaryOffsetSec?: number;
    enabled?: boolean;
  }) => {
    const key = subMemoryKeyRef.current;
    if (!key) return;
    saveSubTrackMemory(key, entry);
  }, []);

  const dragDepthRef = useRef(0);
  const [dragOverSub, setDragOverSub] = useState(false);

  const activeCurUrl = cur?.url ?? "";
  const activeCurUrlRef = useRef(activeCurUrl);
  activeCurUrlRef.current = activeCurUrl;
  // Which stream this is, independent of its URL: a refreshed CDN token on the same server keeps
  // its identity, so the viewer's subtitle, audio and pause choices must survive it.
  const streamIdentity = cur ? `${activeKey}::${cur.localPath ?? ""}` : "";
  const streamIdentityRef = useRef(streamIdentity);
  streamIdentityRef.current = streamIdentity;
  const subsIdentityRef = useRef("");
  const attachIdentityRef = useRef("");
  /** Set when a refresh replaced the URL of a paused stream, so the new one doesn't autoplay. */
  const keepPausedRef = useRef(false);

  const [hlsReady, setHlsReady] = useState(false);
  const [hlsSubsState, setHlsSubsState] = useState<{ url: string; tracks: UnifiedSubTrack[] }>({ url: "", tracks: [] });
  const [nativeSubsState, setNativeSubsState] = useState<{ url: string; tracks: UnifiedSubTrack[] }>({ url: "", tracks: [] });
  const [onlineSubsState, setOnlineSubsState] = useState<{ url: string; tracks: UnifiedSubTrack[] }>({ url: "", tracks: [] });
  const [addedSubs, setAddedSubs] = useState<UnifiedSubTrack[]>([]);
  const [trackDataState, setTrackDataState] = useState<{ url: string; data: Record<string, TrackCueCache> }>({ url: "", data: {} });

  const hlsSubs = hlsSubsState.url === activeCurUrl ? hlsSubsState.tracks : [];
  const nativeSubs = nativeSubsState.url === activeCurUrl ? nativeSubsState.tracks : [];
  const onlineSubs = onlineSubsState.url === activeCurUrl ? onlineSubsState.tracks : [];
  const trackData = trackDataState.url === activeCurUrl ? trackDataState.data : {};

  const setHlsSubs = useCallback((tracks: UnifiedSubTrack[]) => {
    setHlsSubsState({ url: activeCurUrlRef.current, tracks });
  }, []);
  const setNativeSubs = useCallback((tracks: UnifiedSubTrack[]) => {
    const url = activeCurUrlRef.current;
    setNativeSubsState((prev) => {
      if (
        prev.url === url &&
        prev.tracks.length === tracks.length &&
        prev.tracks.every(
          (t, i) =>
            t.id === tracks[i].id &&
            t.label === tracks[i].label &&
            t.lang === tracks[i].lang &&
            t.nativeTrack === tracks[i].nativeTrack,
        )
      ) {
        return prev;
      }
      return { url, tracks };
    });
  }, []);
  const appendOnlineSub = useCallback((url: string, track: UnifiedSubTrack) => {
    setOnlineSubsState((prev) => {
      const list = prev.url === url ? prev.tracks : [];
      return list.some((t) => t.id === track.id) ? { url, tracks: list } : { url, tracks: [...list, track] };
    });
  }, []);
  const patchTrackData = useCallback((url: string, id: string, entry: TrackCueCache) => {
    setTrackDataState((prev) => ({
      url,
      data: prev.url === url ? { ...prev.data, [id]: entry } : { [id]: entry },
    }));
  }, []);

  const trackDataRef = useRef(trackData);
  trackDataRef.current = trackData;
  const trackCtlsRef = useRef(new Map<string, AbortController>());
  const sourceGenRef = useRef(0);

  const candidateSubs = useMemo<UnifiedSubTrack[]>(() => {
    const list = cur?.subtitles;
    if (!list?.length || isEmbed) return [];
    const counts = new Map<string, number>();
    return list.map((s, i) => {
      const baseLabel = s.label || s.lang || `Track ${i + 1}`;
      const n = (counts.get(baseLabel) ?? 0) + 1;
      counts.set(baseLabel, n);
      const label = n > 1 ? `${baseLabel} ${n}` : baseLabel;
      const origin: UnifiedSubTrack["origin"] =
        s.source ?? (s.streamIndex != null || s.url.startsWith("embedded://") ? "embedded" : cur?.providerId === "local" ? "sidecar" : "stream");
      return {
        id: `cand-${i}`,
        label,
        lang: s.lang || "und",
        origin,
        format: s.format,
        isDefault: s.isDefault,
        isForced: s.isForced,
        isHearingImpaired: s.isHearingImpaired,
        url: s.url,
        streamIndex: s.streamIndex,
      };
    });
  }, [cur?.url, cur?.subtitles, cur?.providerId, isEmbed]);

  const subTracks = useMemo<UnifiedSubTrack[]>(() => {
    const raw = [...hlsSubs, ...nativeSubs, ...candidateSubs, ...onlineSubs, ...addedSubs];
    return raw.map((t) => {
      const d = trackData[t.id];
      return d ? { ...t, ...d } : t;
    });
  }, [hlsSubs, nativeSubs, candidateSubs, onlineSubs, addedSubs, trackData]);
  const subTracksRef = useRef(subTracks);
  subTracksRef.current = subTracks;

  const trackStructureKey = useMemo(
    () => [...hlsSubs, ...nativeSubs, ...candidateSubs, ...onlineSubs, ...addedSubs].map((t) => t.id).join("|"),
    [hlsSubs, nativeSubs, candidateSubs, onlineSubs, addedSubs],
  );

  const [selectedSub, setSelectedSub] = useState<string | null>(null);
  const selectedSubRef = useRef<string | null>(null);
  selectedSubRef.current = selectedSub;
  const [secondarySub, setSecondarySub] = useState<string | null>(null);
  const secondarySubRef = useRef<string | null>(null);
  secondarySubRef.current = secondarySub;

  const [audioTracks, setAudioTracks] = useState<{ id: number; label: string; lang: string }[]>([]);
  const [selectedAudioTrack, setSelectedAudioTrack] = useState<number>(-1);
  const manualAudio = useRef(false);
  const pendingSub = useRef<string | null>(null);
  const pendingSecondary = useRef<string | null>(null);
  /** Once the viewer picks a track on this source, stop auto-choosing for them. */
  const manualSub = useRef(false);
  const manualSecondary = useRef(false);
  const lastActiveSubRef = useRef<{ prim: string; sec: string | null } | null>(null);

  const [offset, setOffset] = useState(() => (subMemoryKey ? loadSubTrackMemory(subMemoryKey)?.offsetSec ?? 0 : 0));
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  // The second (dual) subtitle often comes from another release with its own timing.
  const [secOffset, setSecOffset] = useState(() => (subMemoryKey ? loadSubTrackMemory(subMemoryKey)?.secondaryOffsetSec ?? 0 : 0));
  const secOffsetRef = useRef(secOffset);
  secOffsetRef.current = secOffset;
  const [timingShiftUnsupported, setTimingShiftUnsupported] = useState(false);
  const timingShiftUnsupportedRef = useRef(false);

  const [activePrimaryCues, setActivePrimaryCues] = useState<SubtitleCue[]>([]);
  const [activeSecondaryCues, setActiveSecondaryCues] = useState<SubtitleCue[]>([]);
  const lastSigRef = useRef({ prim: "", sec: "" });

  const [onlineResults, setOnlineResults] = useState<OnlineSubtitleResult[]>([]);
  const [onlineLoading, setOnlineLoading] = useState(false);
  const [onlineSearched, setOnlineSearched] = useState(false);
  const [onlineError, setOnlineError] = useState<string | null>(null);
  const [loadingOnlineId, setLoadingOnlineId] = useState<string | null>(null);
  const [loadedOnlineMap, setLoadedOnlineMap] = useState<Map<string, string>>(() => new Map());
  const searchCtlRef = useRef<AbortController | null>(null);
  const loadOnlineCtlsRef = useRef(new Set<AbortController>());
  const autoFetchedRef = useRef(new Set<string>());
  const [savingTrackId, setSavingTrackId] = useState<string | null>(null);
  const [savedTrackIds, setSavedTrackIds] = useState<Set<string>>(() => new Set());

  const ensureTrackLoaded = useCallback(async (track: UnifiedSubTrack) => {
    if (track.origin === "hls" || track.origin === "native" || track.origin === "user") return;
    if (track.cues) return;
    const existing = trackDataRef.current[track.id];
    if (existing?.cues || existing?.loading) return;
    const activeUrl = activeCurUrlRef.current;

    if (track.origin === "embedded" && track.streamIndex != null) {
      const localPath = curRef.current?.localPath;
      if (!localPath) {
        patchTrackData(activeUrl, track.id, { loading: false, error: "Local file path unavailable" });
        return;
      }
      const ctl = new AbortController();
      trackCtlsRef.current.set(track.id, ctl);
      const gen = sourceGenRef.current;
      patchTrackData(activeUrl, track.id, { loading: true, error: undefined });
      try {
        const res = await invoke<ExtractedSubtitleResult>("extract_local_subtitle", {
          path: localPath,
          streamIndex: track.streamIndex,
        });
        if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current) return;
        const parsed = parseSubtitles(res.content, res.format);
        patchTrackData(activeUrl, track.id, { cues: parsed.cues, raw: res.content, format: parsed.format, loading: false, error: undefined });
      } catch (e) {
        if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        patchTrackData(activeUrl, track.id, { loading: false, error: msg });
        if (selectedSubRef.current === track.id || secondarySubRef.current === track.id) {
          flash(`Couldn't extract subtitle: ${msg}`);
        }
      } finally {
        if (trackCtlsRef.current.get(track.id) === ctl) trackCtlsRef.current.delete(track.id);
      }
      return;
    }

    const url = track.url;
    if (!url || url.startsWith("embedded://")) return;
    const ctl = new AbortController();
    trackCtlsRef.current.set(track.id, ctl);
    const gen = sourceGenRef.current;
    patchTrackData(activeUrl, track.id, { loading: true, error: undefined });
    try {
      const parsed = await fetchAndParseSubtitle(url, { formatHint: track.format, signal: ctl.signal });
      if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current) return;
      patchTrackData(activeUrl, track.id, { cues: parsed.cues, raw: parsed.raw, format: parsed.format, loading: false, error: undefined });
    } catch (e) {
      if (ctl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      if (gen !== sourceGenRef.current || !mountedRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      patchTrackData(activeUrl, track.id, { loading: false, error: msg });
      if (selectedSubRef.current === track.id || secondarySubRef.current === track.id) {
        flash(`Couldn't load subtitle: ${msg}`);
      }
    } finally {
      if (trackCtlsRef.current.get(track.id) === ctl) trackCtlsRef.current.delete(track.id);
    }
  }, [patchTrackData]);

  const applySubPair = useCallback((primId: string | null, secId: string | null) => {
    const list = subTracksRef.current;
    const prim = primId ? list.find((x) => x.id === primId) : undefined;
    const safeSecId = secId && (!prim || secId !== prim.id) ? secId : null;
    const sec = safeSecId ? list.find((x) => x.id === safeSecId) : undefined;

    const finalPrim = prim ? prim.id : null;
    const finalSec = sec ? sec.id : null;
    selectedSubRef.current = finalPrim;
    secondarySubRef.current = finalSec;
    setSelectedSub(finalPrim);
    setSecondarySub(finalSec);

    const v = video.current;
    const hls = hlsRef.current;
    if (hls) {
      hls.subtitleDisplay = false;
      const activeHlsIdx =
        prim?.origin === "hls" && prim.hlsIndex != null
          ? prim.hlsIndex
          : sec?.origin === "hls" && sec.hlsIndex != null
            ? sec.hlsIndex
            : -1;
      hls.subtitleTrack = activeHlsIdx;
    }
    const shk = shakaRef.current;
    if (shk) {
      // Shaka streams one text track at a time: the main subtitle's, else the second's.
      const dashSel = prim?.origin === "dash" ? prim : sec?.origin === "dash" ? sec : undefined;
      if (dashSubIdRef.current !== (dashSel?.id ?? null)) dashCollectorRef.current?.reset();
      dashSubIdRef.current = dashSel?.id ?? null;
      const tt = dashSel?.dashTrackId != null ? shk.getTextTracks().find((t) => t.id === dashSel.dashTrackId) : undefined;
      // Shaka 5: selecting a track turns text on; null turns it off (no more visibility toggle).
      shk.selectTextTrack(tt ?? null);
    }

    if (v) {
      for (let i = 0; i < v.textTracks.length; i++) {
        const tt = v.textTracks[i];
        const isNativeSelected =
          (prim?.origin === "native" && prim.nativeTrack === tt) ||
          (sec?.origin === "native" && sec.nativeTrack === tt);
        if (!hls) {
          tt.mode = isNativeSelected ? "hidden" : "disabled";
        } else if (tt.mode === "showing") {
          tt.mode = "hidden";
        }
      }
    }

    if (prim) void ensureTrackLoaded(prim);
    if (sec) void ensureTrackLoaded(sec);
  }, [ensureTrackLoaded]);

  const chooseSub = useCallback((id: string | null) => {
    manualSub.current = true;
    const list = subTracksRef.current;
    const t = id ? list.find((x) => x.id === id) : undefined;
    const curSec = secondarySubRef.current;
    const nextSec = !t ? null : curSec === t.id ? null : curSec;
    if (curSec && !nextSec) manualSecondary.current = true;
    if (t) lastActiveSubRef.current = { prim: t.id, sec: nextSec };
    applySubPair(t ? t.id : null, nextSec);
    const baseLang = t ? langBase(t.lang) : undefined;
    persistTrackMemory(
      t
        ? { enabled: true, selectedLang: baseLang, selectedLabel: t.label }
        : { enabled: false },
    );
    flash(`Subtitles: ${t ? t.label : "Off"}`);
  }, [applySubPair, persistTrackMemory]);

  const chooseSecondary = useCallback((id: string | null) => {
    manualSecondary.current = true;
    const list = subTracksRef.current;
    const t = id ? list.find((x) => x.id === id) : undefined;
    if (t && t.id === selectedSubRef.current) return;
    if (selectedSubRef.current) {
      lastActiveSubRef.current = { prim: selectedSubRef.current, sec: t ? t.id : null };
    }
    applySubPair(selectedSubRef.current, t ? t.id : null);
    const baseLang = t ? langBase(t.lang) : "";
    persistTrackMemory({ secondaryLang: baseLang && baseLang !== "und" ? baseLang : "" });
    flash(t ? `Dual subtitle: ${t.label}` : "Dual subtitle off");
  }, [applySubPair, persistTrackMemory]);

  const findPreferredSub = useCallback((list: UnifiedSubTrack[], p: SubPref) => {
    if (!list.length) return undefined;
    const idx = pickBestSubtitleIndex(list, p, originalLanguage);
    return idx >= 0 ? list[idx] : list[0];
  }, [originalLanguage]);

  const findSecondaryForLang = useCallback((list: UnifiedSubTrack[], wantLang: string, p: SubPref, primaryId: string | null) => {
    const base = langBase(wantLang);
    if (!base || base === "und") return undefined;
    const matching = list.filter((t) => t.id !== primaryId && langBase(t.lang) === base);
    if (!matching.length) return undefined;
    const idx = pickBestSubtitleIndex(matching, { ...p, lang: base }, originalLanguage);
    return idx >= 0 ? matching[idx] : matching[0];
  }, [originalLanguage]);

  // Reset subtitle selection/caches whenever switching streams so auto-pick runs cleanly for the new source.
  useEffect(() => {
    sourceGenRef.current++;
    searchCtlRef.current?.abort();
    searchCtlRef.current = null;
    loadOnlineCtlsRef.current.forEach((ctl) => ctl.abort());
    loadOnlineCtlsRef.current.clear();
    trackCtlsRef.current.forEach((ctl) => ctl.abort());
    trackCtlsRef.current.clear();

    // Same stream with a fresh URL (token refresh): keep what the viewer chose, the online
    // subtitles they loaded and the cues already parsed. Only a different stream starts over.
    const sameStream = !!streamIdentityRef.current && subsIdentityRef.current === streamIdentityRef.current;
    subsIdentityRef.current = streamIdentityRef.current;

    setHlsReady(false);
    setHlsSubsState({ url: activeCurUrl, tracks: [] });
    setNativeSubsState({ url: activeCurUrl, tracks: [] });
    if (sameStream) {
      setOnlineSubsState((prev) => ({ url: activeCurUrl, tracks: prev.tracks }));
      setTrackDataState((prev) => ({ url: activeCurUrl, data: prev.data }));
    } else {
      setOnlineSubsState({ url: activeCurUrl, tracks: [] });
      setTrackDataState({ url: activeCurUrl, data: {} });
    }
    setOnlineResults([]);
    setOnlineLoading(false);
    setOnlineSearched(false);
    setOnlineError(null);
    setLoadingOnlineId(null);
    setSavingTrackId(null);
    setSavedTrackIds(new Set());
    if (sameStream) return;
    setLoadedOnlineMap(new Map());
    manualSub.current = false;
    manualSecondary.current = false;
    lastActiveSubRef.current = null;
    selectedSubRef.current = null;
    secondarySubRef.current = null;
    setSelectedSub(null);
    setSecondarySub(null);
    lastSigRef.current = { prim: "", sec: "" };
    setActivePrimaryCues([]);
    setActiveSecondaryCues([]);
    timingShiftUnsupportedRef.current = false;
    setTimingShiftUnsupported(false);
    const restoredMemory = subMemoryKeyRef.current ? loadSubTrackMemory(subMemoryKeyRef.current) : null;
    const restoredOffset = restoredMemory?.offsetSec ?? 0;
    offsetRef.current = restoredOffset;
    setOffset(restoredOffset);
    const restoredSecOffset = restoredMemory?.secondaryOffsetSec ?? 0;
    secOffsetRef.current = restoredSecOffset;
    setSecOffset(restoredSecOffset);
  }, [activeCurUrl]);

  // Apply pending user-loaded tracks or auto-pick best primary + optional dual track when available tracks change.
  useEffect(() => {
    const list = subTracksRef.current;
    if (pendingSub.current && list.some((t) => t.id === pendingSub.current)) {
      const id = pendingSub.current;
      pendingSub.current = null;
      chooseSub(id);
      return;
    }
    if (pendingSecondary.current && list.some((t) => t.id === pendingSecondary.current)) {
      const secId = pendingSecondary.current;
      pendingSecondary.current = null;
      chooseSecondary(secId);
      return;
    }
    if (manualSub.current) return;

    const p = prefRef.current;
    const mem = subMemoryKey ? loadSubTrackMemory(subMemoryKey) : null;
    const wantOn =
      mem?.enabled !== undefined
        ? mem.enabled
        : shouldAutoEnableSubtitles(p, audio, originalLanguage);

    if (!wantOn || !list.length) {
      applySubPair(null, null);
      return;
    }

    let prim: UnifiedSubTrack | undefined;
    if (mem?.selectedLabel) {
      prim = list.find((t) => t.label === mem.selectedLabel);
    }
    if (!prim && mem?.selectedLang && mem.selectedLang !== "und") {
      prim = list.find((t) => langBase(t.lang) === langBase(mem.selectedLang) && !t.isForced)
        ?? list.find((t) => langBase(t.lang) === langBase(mem.selectedLang));
    }
    if (!prim) {
      prim = findPreferredSub(list, p);
    }

    let sec: UnifiedSubTrack | undefined;
    if (!manualSecondary.current && prim && list.length > 1) {
      const wantSecLang = mem?.secondaryLang !== undefined ? mem.secondaryLang : p.secondaryLang;
      if (wantSecLang) {
        sec = findSecondaryForLang(list, wantSecLang, p, prim.id);
      }
    }

    applySubPair(prim?.id ?? null, sec?.id ?? null);
  }, [activeCurUrl, trackStructureKey, subMemoryKey, audio, originalLanguage, applySubPair, chooseSub, chooseSecondary, findPreferredSub, findSecondaryForLang]);

  // Reset user-dropped files when moving to another title or episode, while keeping them across server switches.
  useEffect(() => {
    setAddedSubs([]);
  }, [subMemoryKey]);

  const toggleSub = useCallback(() => {
    const list = subTracksRef.current;
    if (!list.length) {
      flash("No subtitles loaded — open Subtitles to search or drop a file");
      return;
    }
    if (selectedSubRef.current || secondarySubRef.current) {
      if (selectedSubRef.current) {
        lastActiveSubRef.current = { prim: selectedSubRef.current, sec: secondarySubRef.current };
      }
      chooseSub(null);
      return;
    }
    const last = lastActiveSubRef.current;
    if (last && list.some((t) => t.id === last.prim)) {
      manualSub.current = true;
      const sec = last.sec && list.some((t) => t.id === last.sec && t.id !== last.prim) ? last.sec : null;
      applySubPair(last.prim, sec);
      const t = list.find((x) => x.id === last.prim);
      const baseLang = t ? langBase(t.lang) : undefined;
      persistTrackMemory({ enabled: true, selectedLang: baseLang, selectedLabel: t?.label });
      flash(`Subtitles: ${t?.label ?? "On"}`);
      return;
    }
    chooseSub(findPreferredSub(list, prefRef.current)?.id ?? null);
  }, [applySubPair, chooseSub, findPreferredSub, persistTrackMemory]);

  const cycleSub = useCallback(() => {
    const list = subTracksRef.current;
    if (!list.length) {
      flash("No subtitle tracks loaded");
      return;
    }
    const curId = selectedSubRef.current;
    if (!curId) {
      chooseSub(list[0].id);
      return;
    }
    const i = list.findIndex((t) => t.id === curId);
    const next = i >= 0 && i + 1 < list.length ? list[i + 1].id : null;
    chooseSub(next);
  }, [chooseSub]);

  const addSubtitleFiles = useCallback(async (files: FileList | File[]) => {
    const all = Array.from(files);
    const valid = all.filter((f) => SUB_FILE_EXT_RX.test(f.name));
    if (!valid.length) {
      flash("Drop an .srt, .vtt, .ass, or .ssa subtitle file");
      return;
    }
    let firstId: string | null = null;
    const loadedTracks: UnifiedSubTrack[] = [];
    for (const file of valid) {
      try {
        const buf = await file.arrayBuffer();
        const raw = decodeSubtitle(buf);
        const extMatch = file.name.match(SUB_FILE_EXT_RX);
        const hint = extMatch ? (extMatch[1].toLowerCase() as SubtitleFormat) : undefined;
        const parsed = parseSubtitles(raw, hint);
        const id = `added-${crypto.randomUUID()}`;
        const lang = inferUserSubLang(file.name);
        if (!firstId) firstId = id;
        loadedTracks.push({
          id,
          label: file.name,
          lang,
          origin: "user",
          format: hint ?? parsed.format,
          raw,
          cues: parsed.cues,
        });
      } catch (e) {
        flash(`Couldn't load ${file.name}: ${e instanceof Error ? e.message : "invalid file"}`);
      }
    }
    if (loadedTracks.length && mountedRef.current) {
      if (firstId) pendingSub.current = firstId;
      setAddedSubs((curList) => [...curList, ...loadedTracks]);
      flash(loadedTracks.length === 1 ? `Loaded subtitle: ${loadedTracks[0].label}` : `Loaded ${loadedTracks.length} subtitle files`);
    }
  }, []);

  const nudge = useCallback((delta: number) => {
    if (timingShiftUnsupportedRef.current) {
      flash("Timing offset isn't supported on active-cue-only tracks");
      return;
    }
    const n = Math.round((offsetRef.current + delta) * 10) / 10;
    offsetRef.current = n;
    setOffset(n);
    persistTrackMemory({ offsetSec: n });
    flash(`Subtitle timing ${n > 0 ? "+" : ""}${n.toFixed(1)}s`);
  }, [persistTrackMemory]);

  const resetOffset = useCallback(() => {
    if (timingShiftUnsupportedRef.current) {
      flash("Timing offset isn't supported on active-cue-only tracks");
      return;
    }
    offsetRef.current = 0;
    setOffset(0);
    persistTrackMemory({ offsetSec: 0 });
    flash("Subtitle timing reset (0.0s)");
  }, [persistTrackMemory]);

  const nudgeSecondary = useCallback((delta: number) => {
    const n = Math.round((secOffsetRef.current + delta) * 10) / 10;
    secOffsetRef.current = n;
    setSecOffset(n);
    persistTrackMemory({ secondaryOffsetSec: n });
    flash(`Second subtitle timing ${n > 0 ? "+" : ""}${n.toFixed(1)}s`);
  }, [persistTrackMemory]);

  const resetSecondaryOffset = useCallback(() => {
    secOffsetRef.current = 0;
    setSecOffset(0);
    persistTrackMemory({ secondaryOffsetSec: 0 });
    flash("Second subtitle timing reset (0.0s)");
  }, [persistTrackMemory]);

  const readOptionalSubdlApiKey = useCallback((): string | undefined => {
    try {
      const raw = getSettings().subdlApiKey;
      return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
    } catch {
      return undefined;
    }
  }, []);

  const searchOnline = useCallback(
    async (rawTitle: string, lang: string, epOverride?: { season?: number; episode?: number }) => {
      searchCtlRef.current?.abort();
      const ctl = new AbortController();
      searchCtlRef.current = ctl;
      const gen = sourceGenRef.current;

      const typedTitle = rawTitle.trim();
      const mediaTitle = (media?.title || title || "").trim();
      const qTitle = (typedTitle || mediaTitle).trim();
      const customQuery =
        Boolean(typedTitle) &&
        normalizeMatchTitle(typedTitle) !== normalizeMatchTitle(mediaTitle) &&
        normalizeMatchTitle(typedTitle) !== normalizeMatchTitle(media?.originalTitle);

      const qLang = lang || prefRef.current.lang || "en";
      const secLang = prefRef.current.secondaryLang?.trim();
      const languages = [...new Set([qLang, ...(secLang ? [secLang] : [])])];
      const kind: "movie" | "tv" | "anime" | undefined =
        media?.kind === "tv" || media?.kind === "anime" || media?.kind === "movie"
          ? media.kind
          : (epOverride?.episode ?? epNumber) != null
            ? "tv"
            : undefined;

      setOnlineLoading(true);
      setOnlineError(null);
      try {
        const results = await searchOnlineSubtitles(
          {
            ...(customQuery
              ? {}
              : {
                  tmdbId: media?.tmdbId,
                  imdbId: media?.imdbId,
                  anilistId: media?.anilistId,
                  malId: media?.malId,
                  mediaKey: media?.key,
                  year: media?.year,
                }),
            title: qTitle || undefined,
            kind: customQuery ? undefined : kind,
            season: epOverride?.season ?? epSeason,
            episode: epOverride?.episode ?? epNumber,
            languages,
            preferHearingImpaired: prefRef.current.preferHearingImpaired,
            localPath: customQuery ? undefined : curRef.current?.localPath,
            subdlApiKey: readOptionalSubdlApiKey(),
          },
          ctl.signal,
        );
        if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current) return;
        setOnlineResults(results);
        setOnlineSearched(true);
      } catch (e) {
        if (ctl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        if (gen !== sourceGenRef.current || !mountedRef.current) return;
        setOnlineError(e instanceof Error ? e.message : "Failed to search online subtitles");
        setOnlineSearched(true);
      } finally {
        if (!ctl.signal.aborted && gen === sourceGenRef.current && mountedRef.current) {
          setOnlineLoading(false);
        }
      }
    },
    [media?.tmdbId, media?.imdbId, media?.anilistId, media?.malId, media?.key, media?.title, media?.originalTitle, media?.year, media?.kind, title, epSeason, epNumber, readOptionalSubdlApiKey],
  );

  const loadOnlineResult = useCallback(async (res: OnlineSubtitleResult, asSecondary: boolean) => {
    const existingTrackId = loadedOnlineMap.get(res.id);
    if (existingTrackId && subTracksRef.current.some((t) => t.id === existingTrackId)) {
      if (asSecondary) chooseSecondary(existingTrackId);
      else chooseSub(existingTrackId);
      return;
    }

    const ctl = new AbortController();
    loadOnlineCtlsRef.current.add(ctl);
    const gen = sourceGenRef.current;
    const activeUrl = activeCurUrlRef.current;
    setLoadingOnlineId(res.id);
    try {
      const parsed = await fetchAndParseSubtitle(res.url, { formatHint: res.format, signal: ctl.signal, episode: epRef.current });
      if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current) return;
      const trackId = `online-${res.id}`;
      const label = res.release ? `${res.langName || res.lang} · ${res.release}` : (res.langName || res.lang);
      const track: UnifiedSubTrack = {
        id: trackId,
        label,
        lang: res.lang,
        origin: "online",
        format: res.format,
        url: res.url,
        provider: res.provider,
        release: res.release,
        isHearingImpaired: res.hearingImpaired,
        isForced: res.forced,
      };

      patchTrackData(activeUrl, trackId, { cues: parsed.cues, raw: parsed.raw, format: res.format ?? parsed.format, loading: false });
      setLoadedOnlineMap((prev) => {
        const next = new Map(prev);
        next.set(res.id, trackId);
        return next;
      });
      if (asSecondary) pendingSecondary.current = trackId;
      else pendingSub.current = trackId;
      appendOnlineSub(activeUrl, track);
    } catch (e) {
      if (ctl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      if (mountedRef.current) {
        flash(`Online subtitle failed: ${e instanceof Error ? e.message : "download error"}`);
      }
    } finally {
      loadOnlineCtlsRef.current.delete(ctl);
      if (!ctl.signal.aborted && gen === sourceGenRef.current && mountedRef.current) {
        setLoadingOnlineId((curId) => (curId === res.id ? null : curId));
      }
    }
  }, [loadedOnlineMap, chooseSub, chooseSecondary, patchTrackData, appendOnlineSub]);

  const canSaveSidecar = Boolean(!isEmbed && cur?.localPath && isTauri());

  const saveSidecar = useCallback(async (track: UnifiedSubTrack) => {
    const videoPath = curRef.current?.localPath;
    if (!videoPath || savingTrackId) return;
    setSavingTrackId(track.id);
    try {
      const cached = trackDataRef.current[track.id];
      let content = cached?.raw ?? track.raw;
      let ext: SubtitleFormat | undefined = cached?.format ?? track.format;
      if (!content && (cached?.cues?.length || track.cues?.length)) {
        content = cuesToVtt(cached?.cues ?? track.cues ?? []);
        ext = "vtt";
      }
      if (!content && track.url) {
        const parsed = await fetchAndParseSubtitle(track.url, { formatHint: track.format });
        content = parsed.raw;
        ext = parsed.format;
      }
      if (!content) {
        flash("No subtitle content available to save");
        return;
      }
      const safeExt = ext === "ass" || ext === "ssa" || ext === "vtt" ? ext : "srt";
      const baseName = videoPath.split(/[\\/]/).pop() ?? "video";
      const stem =
        baseName
          .replace(/\.[^.]+$/, "")
          .replace(/[\/\\:*?"<>|\x00]/g, "_")
          .replace(/\.{2,}/g, ".") || "subtitle";
      const lang = langBase(track.lang);
      const filename = lang && lang !== "und" ? `${stem}.${lang}.${safeExt}` : `${stem}.${safeExt}`;
      await invoke<string>("save_sidecar_subtitle", {
        videoPath,
        filename,
        content,
      });
      void refreshDownloads({ minIntervalMs: 0 });
      if (!mountedRef.current) return;
      setSavedTrackIds((prev) => {
        const next = new Set(prev);
        next.add(track.id);
        return next;
      });
      flash(`Saved ${filename} next to video`);
    } catch (e) {
      if (mountedRef.current) {
        flash(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (mountedRef.current) setSavingTrackId(null);
    }
  }, [savingTrackId]);

  // Optional auto-fetch online subtitles when enabled, subtitles aren't off, and candidate lacks user's language.
  useEffect(() => {
    const mem = subMemoryKey ? loadSubTrackMemory(subMemoryKey) : null;
    if (!cur || isEmbed || !pref.autoFetchOnline) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    if (mem?.enabled === false || (pref.mode === "off" && mem?.enabled !== true)) return;
    if ((cur.kind === "hls" || cur.kind === "dash") && !hlsReady) return;
    const wantLang = langBase(pref.lang || "en");
    const fetchKey = `${cur.url}::${wantLang}`;
    if (autoFetchedRef.current.has(fetchKey)) return;
    if (manualSub.current) return;

    const ctl = new AbortController();
    const gen = sourceGenRef.current;
    const activeUrl = activeCurUrlRef.current;
    const timer = window.setTimeout(async () => {
      if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current) return;
      if (manualSub.current) return;
      const list = subTracksRef.current;
      const hasMatchingLang = list.some((t) => langBase(t.lang) === wantLang && !t.isForced);
      if (hasMatchingLang) {
        autoFetchedRef.current.add(fetchKey);
        return;
      }
      const qTitle = (media?.title || title || "").trim();
      const localPath = curRef.current?.localPath;
      if (!qTitle && !media?.tmdbId && !media?.imdbId && !localPath) return;
      autoFetchedRef.current.add(fetchKey);
      const kind: "movie" | "tv" | "anime" | undefined =
        media?.kind === "tv" || media?.kind === "anime" || media?.kind === "movie"
          ? media.kind
          : epNumber != null
            ? "tv"
            : undefined;
      try {
        const results = await searchOnlineSubtitles(
          {
            tmdbId: media?.tmdbId,
            imdbId: media?.imdbId,
            title: qTitle || undefined,
            year: media?.year,
            kind,
            season: epSeason,
            episode: epNumber,
            languages: [wantLang],
            preferHearingImpaired: prefRef.current.preferHearingImpaired,
            localPath,
            subdlApiKey: readOptionalSubdlApiKey(),
          },
          ctl.signal,
        );
        if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current || !results.length) return;
        setOnlineResults(results);
        setOnlineSearched(true);
        const top = results[0];
        const parsed = await fetchAndParseSubtitle(top.url, { formatHint: top.format, signal: ctl.signal, episode: epRef.current });
        if (ctl.signal.aborted || gen !== sourceGenRef.current || !mountedRef.current || manualSub.current) return;
        const trackId = `online-${top.id}`;
        const label = top.release ? `${top.langName || top.lang} · ${top.release}` : (top.langName || top.lang);
        const track: UnifiedSubTrack = {
          id: trackId,
          label,
          lang: top.lang,
          origin: "online",
          format: top.format,
          url: top.url,
          provider: top.provider,
          release: top.release,
          isHearingImpaired: top.hearingImpaired,
          isForced: top.forced,
        };
        patchTrackData(activeUrl, trackId, { cues: parsed.cues, raw: parsed.raw, format: top.format ?? parsed.format, loading: false });
        setLoadedOnlineMap((prev) => {
          const next = new Map(prev);
          next.set(top.id, trackId);
          return next;
        });
        pendingSub.current = trackId;
        appendOnlineSub(activeUrl, track);
        flash(`Auto-loaded ${top.langName || wantLang} subtitle`);
      } catch {
        /* ignore background auto-fetch errors */
      }
    }, 650);

    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [cur?.url, cur?.localPath, cur?.kind, isEmbed, hlsReady, subMemoryKey, pref.autoFetchOnline, pref.mode, pref.lang, media?.tmdbId, media?.imdbId, media?.title, media?.year, media?.kind, title, epSeason, epNumber, patchTrackData, appendOnlineSub, readOptionalSubdlApiKey]);

  const findHlsTextTrack = useCallback((v: HTMLVideoElement, track: UnifiedSubTrack, activeHlsIndex: number): TextTrack | null => {
    const vTracks = Array.from(v.textTracks).filter((t) => t.kind === "subtitles" || t.kind === "captions");
    if (!vTracks.length) return null;
    const base = langBase(track.lang);
    return (
      vTracks.find((t) => t.label === track.label && (base === "und" || langBase(t.language) === base)) ??
      vTracks.find((t) => track.hlsIndex === activeHlsIndex && (t.mode === "hidden" || t.mode === "showing")) ??
      vTracks.find((t) => t.label === track.label) ??
      (track.hlsIndex != null && vTracks.length === hlsSubs.length ? vTracks[track.hlsIndex] : null) ??
      null
    );
  }, [hlsSubs.length]);

  const evaluateCues = useCallback(() => {
    const v = video.current;
    if (!v || isEmbed) {
      if (lastSigRef.current.prim || lastSigRef.current.sec) {
        lastSigRef.current = { prim: "", sec: "" };
        setActivePrimaryCues([]);
        setActiveSecondaryCues([]);
      }
      if (timingShiftUnsupportedRef.current) {
        timingShiftUnsupportedRef.current = false;
        setTimingShiftUnsupported(false);
      }
      return;
    }

    const list = subTracksRef.current;
    const primTrack = selectedSubRef.current ? list.find((t) => t.id === selectedSubRef.current) : undefined;
    const secTrack = secondarySubRef.current ? list.find((t) => t.id === secondarySubRef.current) : undefined;
    const tSec = v.currentTime || 0;
    const hls = hlsRef.current;

    const resolve = (track: UnifiedSubTrack | undefined, offSec: number): { cues: SubtitleCue[]; activeFallback: boolean } => {
      if (!track) return { cues: [], activeFallback: false };
      const cached = trackDataRef.current[track.id]?.cues ?? track.cues;
      if (cached) return { cues: activeCuesAt(cached, tSec, offSec), activeFallback: false };
      if (track.origin === "native" && track.nativeTrack) {
        if (track.nativeTrack.mode !== "hidden") track.nativeTrack.mode = "hidden";
        const { cues, usingActiveFallback } = textTrackToCues(track.nativeTrack, track.id);
        return { cues: usingActiveFallback ? cues : activeCuesAt(cues, tSec, offSec), activeFallback: usingActiveFallback };
      }
      if (track.origin === "hls" && hls) {
        const tt = findHlsTextTrack(v, track, hls.subtitleTrack);
        if (!tt) return { cues: [], activeFallback: false };
        if (tt.mode === "disabled" && track.hlsIndex === hls.subtitleTrack) tt.mode = "hidden";
        if (tt.mode === "showing") tt.mode = "hidden";
        const { cues, usingActiveFallback } = textTrackToCues(tt, track.id);
        return { cues: usingActiveFallback ? cues : activeCuesAt(cues, tSec, offSec), activeFallback: usingActiveFallback };
      }
      return { cues: [], activeFallback: false };
    };

    const primRes = resolve(primTrack, offsetRef.current);
    const secRes = resolve(secTrack, secOffsetRef.current);
    const nextPrim = primRes.cues;
    const nextSec = secRes.cues;
    const nextUnsupported = primTrack ? primRes.activeFallback : secTrack ? secRes.activeFallback : false;
    if (nextUnsupported !== timingShiftUnsupportedRef.current) {
      timingShiftUnsupportedRef.current = nextUnsupported;
      setTimingShiftUnsupported(nextUnsupported);
    }

    const primSig = cueSignature(nextPrim);
    const secSig = cueSignature(nextSec);

    if (primSig !== lastSigRef.current.prim) {
      lastSigRef.current.prim = primSig;
      setActivePrimaryCues(nextPrim);
    }
    if (secSig !== lastSigRef.current.sec) {
      lastSigRef.current.sec = secSig;
      setActiveSecondaryCues(nextSec);
    }
  }, [isEmbed, findHlsTextTrack]);
  const evaluateCuesRef = useRef(evaluateCues);
  evaluateCuesRef.current = evaluateCues;

  // Unified Cue Engine: syncs <video>.textTracks, cuechange events, seeked, and active playback cadence.
  useEffect(() => {
    const v = video.current;
    if (!v || isEmbed) return;
    let boundPrimary: TextTrack | null = null;
    let boundSecondary: TextTrack | null = null;
    const run = () => evaluateCuesRef.current();

    const syncTextTrackBindings = () => {
      const primTrack = selectedSubRef.current ? subTracksRef.current.find((t) => t.id === selectedSubRef.current) : undefined;
      const secTrack = secondarySubRef.current ? subTracksRef.current.find((t) => t.id === secondarySubRef.current) : undefined;
      const hls = hlsRef.current;

      const resolveTt = (t: UnifiedSubTrack | undefined): TextTrack | null => {
        if (!t) return null;
        if (t.origin === "native" && t.nativeTrack) return t.nativeTrack;
        if (t.origin === "hls" && hls) return findHlsTextTrack(v, t, hls.subtitleTrack);
        return null;
      };

      const nextP = resolveTt(primTrack);
      const nextS = resolveTt(secTrack);
      for (let i = 0; i < v.textTracks.length; i++) {
        const tt = v.textTracks[i];
        const isActive = tt === nextP || tt === nextS;
        if (tt.mode === "showing") {
          tt.mode = isActive || hls ? "hidden" : "disabled";
        } else if (!hls && !isActive && tt.mode !== "disabled") {
          tt.mode = "disabled";
        } else if (!hls && isActive && tt.mode !== "hidden") {
          tt.mode = "hidden";
        }
      }
      if (nextP !== boundPrimary) {
        boundPrimary?.removeEventListener("cuechange", run);
        boundPrimary = nextP;
        boundPrimary?.addEventListener("cuechange", run);
      }
      if (nextS !== boundSecondary) {
        boundSecondary?.removeEventListener("cuechange", run);
        boundSecondary = nextS;
        boundSecondary?.addEventListener("cuechange", run);
      }
      run();
    };

    v.textTracks.addEventListener("change", syncTextTrackBindings);
    v.textTracks.addEventListener("addtrack", syncTextTrackBindings);
    v.addEventListener("timeupdate", run);
    v.addEventListener("seeked", run);
    v.addEventListener("playing", run);
    v.addEventListener("pause", run);
    syncTextTrackBindings();

    return () => {
      v.textTracks.removeEventListener("change", syncTextTrackBindings);
      v.textTracks.removeEventListener("addtrack", syncTextTrackBindings);
      v.removeEventListener("timeupdate", run);
      v.removeEventListener("seeked", run);
      v.removeEventListener("playing", run);
      v.removeEventListener("pause", run);
      boundPrimary?.removeEventListener("cuechange", run);
      boundSecondary?.removeEventListener("cuechange", run);
    };
  }, [cur?.url, isEmbed, selectedSub, secondarySub, findHlsTextTrack]);

  // Cue sync while playing. Tracks with parsed cues (files, online and stream subtitles) sleep
  // until the next cue boundary instead of waking every 60 ms; HLS / native text tracks, whose cue
  // lists grow as segments load, keep the 60 ms cadence. Seeks and speed changes resync at once.
  useEffect(() => {
    const v = video.current;
    if (isEmbed || !playing || !v || (!selectedSub && !secondarySub)) return;
    let timer: number | undefined;
    let alive = true;
    const delayMs = (): number => {
      const list = subTracksRef.current;
      const ids = [selectedSubRef.current, secondarySubRef.current].filter((id): id is string => !!id);
      const t = v.currentTime || 0;
      let boundary = Infinity;
      for (const id of ids) {
        const track = list.find((x) => x.id === id);
        const cues = track ? trackDataRef.current[track.id]?.cues ?? track.cues : undefined;
        if (!cues) return 60; // live text track: keep polling
        const off = id === selectedSubRef.current ? offsetRef.current : secOffsetRef.current;
        boundary = Math.min(boundary, nextCueBoundaryAfter(cues, t, off));
      }
      if (!Number.isFinite(boundary)) return 250;
      const ms = ((boundary - t) * 1000) / (v.playbackRate || 1);
      return Math.min(250, Math.max(16, ms + 2));
    };
    const tick = () => {
      if (!alive) return;
      evaluateCuesRef.current();
      timer = window.setTimeout(tick, delayMs());
    };
    const resync = () => {
      window.clearTimeout(timer);
      tick();
    };
    tick();
    v.addEventListener("seeked", resync);
    v.addEventListener("ratechange", resync);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      v.removeEventListener("seeked", resync);
      v.removeEventListener("ratechange", resync);
    };
  }, [isEmbed, playing, selectedSub, secondarySub, offset, secOffset, trackData]);

  // Dual subtitles from two HLS tracks: hls.js loads only one subtitle track, so the other is
  // fetched beside it (lib/hlsSideSubs) and handed to the cue engine as parsed cues.
  const sideHlsTrack = useMemo(() => {
    const prim = selectedSub ? hlsSubs.find((t) => t.id === selectedSub) : undefined;
    const sec = secondarySub ? hlsSubs.find((t) => t.id === secondarySub) : undefined;
    // hls.js serves the primary's HLS track when it has one (see applySubPair); the other is ours.
    if (prim?.hlsIndex != null && sec?.hlsIndex != null && prim.hlsIndex !== sec.hlsIndex) return sec;
    return undefined;
  }, [selectedSub, secondarySub, hlsSubs]);
  useEffect(() => {
    const v = video.current;
    const hls = hlsRef.current;
    const track = sideHlsTrack;
    if (!v || !hls || !track || track.hlsIndex == null) return;
    const playlistUrl = hls.subtitleTracks[track.hlsIndex]?.url;
    if (!playlistUrl) return;
    const activeUrl = activeCurUrlRef.current;
    patchTrackData(activeUrl, track.id, { loading: true });
    const loader = createHlsSideLoader({
      playlistUrl,
      getInitPtsSec: () => initPtsRef.current,
      onCues: (cues) => {
        if (activeCurUrlRef.current !== activeUrl) return;
        patchTrackData(activeUrl, track.id, { cues, format: "vtt", loading: false });
      },
    });
    const onTime = () => loader.ensure(v.currentTime);
    onTime();
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("seeked", onTime);
    return () => {
      loader.dispose();
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("seeked", onTime);
    };
  }, [sideHlsTrack, activeCurUrl, patchTrackData]);

  // Re-evaluate immediately when offset, selection, or cached parsed cues change (even while paused).
  useEffect(() => {
    evaluateCues();
  }, [selectedSub, secondarySub, offset, secOffset, trackData, evaluateCues]);

  // Cleanup any in-flight subtitle requests on unmount.
  useEffect(() => () => {
    sourceGenRef.current++;
    searchCtlRef.current?.abort();
    loadOnlineCtlsRef.current.forEach((c) => c.abort());
    loadOnlineCtlsRef.current.clear();
    trackCtlsRef.current.forEach((c) => c.abort());
    trackCtlsRef.current.clear();
  }, []);

  return { activeCurUrlRef, activePrimaryCues, activeSecondaryCues, addSubtitleFiles, attachIdentityRef, audioTracks, canSaveSidecar, chooseSecondary, chooseSub, dragDepthRef, dragOverSub, epNumber, epSeason, evaluateCuesRef, keepPausedRef, lastActiveSubRef, loadOnlineResult, loadedOnlineMap, loadingOnlineId, manualAudio, nudge, nudgeSecondary, offset, offsetRef, onlineError, onlineLoading, onlineResults, onlineSearched, patchPref, patchTrackData, pref, resetOffset, resetSecondaryOffset, saveSidecar, savedTrackIds, savingTrackId, searchOnline, secOffset, secondarySub, secondarySubRef, selectedAudioTrack, selectedSub, selectedSubRef, setAudioTracks, setDragOverSub, setHlsReady, setHlsSubs, setNativeSubs, setSelectedAudioTrack, streamIdentityRef, subTracks, timingShiftUnsupported, toggleSub, trackData, cycleSub };
}

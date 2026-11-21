/**
 * The stream engine: attaches the chosen candidate to the <video> (hls.js, Shaka for DASH,
 * plain files, torrents, local files with FFmpeg-prepared audio), audio-track choice, the
 * start/stall watchdog, mid-stream token refresh and failover hand-off. Lifted verbatim out of
 * Player.tsx (PERF-06): same hooks in the same order, with the player's state passed in.
 */
import type Hls from "hls.js";
import type shaka from "shaka-player";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef } from "react";
import { DashCueCollector } from "../../lib/dashCues";
import { langLabel, preferredAudioTrackIndex } from "../../lib/subtitles";
import { getSettings, type Audio } from "../../lib/settings";
import type { StreamCandidate } from "../../sources/types";
import { isUrlTokenExpired, native, playbackUrl, proxyUrl, unwrapProxyUrl } from "../../sources/native";
import type { SourceSession } from "../../sources/session";
import { type UnifiedSubTrack } from "../SubtitleSheet";
import { candKey, type TrackCueCache } from "./shared";
import type * as React from "react";

export interface StreamEngineContext {
  activeCurUrlRef: React.MutableRefObject<string>;
  activeSessionRef: React.MutableRefObject<number>;
  activeTorrentIdRef: React.MutableRefObject<number | null>;
  attachIdentityRef: React.MutableRefObject<string>;
  attachStartRef: React.MutableRefObject<number>;
  audio: Audio | undefined;
  audioTracks: { id: number; label: string; lang: string; }[];
  clearStall: () => void;
  cur: StreamCandidate | undefined;
  curRef: React.MutableRefObject<StreamCandidate | undefined>;
  dashCollectorRef: React.MutableRefObject<DashCueCollector | null>;
  dashHeightsRef: React.MutableRefObject<number[]>;
  dashSubIdRef: React.MutableRefObject<string | null>;
  embedPos: React.MutableRefObject<{ time: number; duration: number; }>;
  evaluateCuesRef: React.MutableRefObject<() => void>;
  failover: (why: string) => void;
  flash: (msg: string) => void;
  hlsRef: React.MutableRefObject<Hls | null>;
  initPtsRef: React.MutableRefObject<number | null>;
  keepPausedRef: React.MutableRefObject<boolean>;
  localAudioModeRef: React.MutableRefObject<boolean>;
  localAudioRef: React.MutableRefObject<number | null>;
  manualAudio: React.MutableRefObject<boolean>;
  mountedRef: React.MutableRefObject<boolean>;
  originalLanguage: string | undefined;
  patchTrackData: (url: string, id: string, entry: TrackCueCache) => void;
  preparingLocal: boolean;
  preparingTorrent: boolean;
  refreshCtlRef: React.MutableRefObject<AbortController | null>;
  resumeAt: React.MutableRefObject<number>;
  retrySeq: number;
  saveNowRef: React.MutableRefObject<() => void>;
  secondarySubRef: React.MutableRefObject<string | null>;
  selectedAudioTrack: number;
  selectedSubRef: React.MutableRefObject<string | null>;
  session: SourceSession;
  setActiveLevel: React.Dispatch<React.SetStateAction<number>>;
  setAudioTracks: React.Dispatch<React.SetStateAction<{ id: number; label: string; lang: string; }[]>>;
  setDur: React.Dispatch<React.SetStateAction<number>>;
  setEmbedClock: React.Dispatch<React.SetStateAction<{ time: number; duration: number; }>>;
  setEnded: React.Dispatch<React.SetStateAction<boolean>>;
  setFatal: React.Dispatch<React.SetStateAction<{ why: string; server?: string | undefined; } | null>>;
  setHasStarted: React.Dispatch<React.SetStateAction<boolean>>;
  setHlsReady: React.Dispatch<React.SetStateAction<boolean>>;
  setHlsSubs: (tracks: UnifiedSubTrack[]) => void;
  setLevel: React.Dispatch<React.SetStateAction<number>>;
  setLevels: React.Dispatch<React.SetStateAction<{ height: number; }[]>>;
  setLiveStreamId: React.Dispatch<React.SetStateAction<string | null>>;
  setNativeSubs: (tracks: UnifiedSubTrack[]) => void;
  setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  setPreparingLocal: React.Dispatch<React.SetStateAction<boolean>>;
  setPreparingTorrent: React.Dispatch<React.SetStateAction<boolean>>;
  setRecovering: React.Dispatch<React.SetStateAction<boolean>>;
  setRetrySeq: React.Dispatch<React.SetStateAction<number>>;
  setSelectedAudioTrack: React.Dispatch<React.SetStateAction<number>>;
  setTime: (t: number) => void;
  setVideoHeight: React.Dispatch<React.SetStateAction<number | undefined>>;
  setWaiting: React.Dispatch<React.SetStateAction<boolean>>;
  shakaRef: React.MutableRefObject<shaka.Player | null>;
  stallTimer: React.MutableRefObject<number | undefined>;
  started: React.MutableRefObject<boolean>;
  stopActiveTorrent: () => void;
  streamIdentityRef: React.MutableRefObject<string>;
  video: React.RefObject<HTMLVideoElement>;
}

export function useStreamEngine(ctx: StreamEngineContext) {
  const {
    activeCurUrlRef,
    activeSessionRef,
    activeTorrentIdRef,
    attachIdentityRef,
    attachStartRef,
    audio,
    audioTracks,
    clearStall,
    cur,
    curRef,
    dashCollectorRef,
    dashHeightsRef,
    dashSubIdRef,
    embedPos,
    evaluateCuesRef,
    failover,
    flash,
    hlsRef,
    initPtsRef,
    keepPausedRef,
    localAudioModeRef,
    localAudioRef,
    manualAudio,
    mountedRef,
    originalLanguage,
    patchTrackData,
    preparingLocal,
    preparingTorrent,
    refreshCtlRef,
    resumeAt,
    retrySeq,
    saveNowRef,
    secondarySubRef,
    selectedAudioTrack,
    selectedSubRef,
    session,
    setActiveLevel,
    setAudioTracks,
    setDur,
    setEmbedClock,
    setEnded,
    setFatal,
    setHasStarted,
    setHlsReady,
    setHlsSubs,
    setLevel,
    setLevels,
    setLiveStreamId,
    setNativeSubs,
    setPlaying,
    setPreparingLocal,
    setPreparingTorrent,
    setRecovering,
    setRetrySeq,
    setSelectedAudioTrack,
    setTime,
    setVideoHeight,
    setWaiting,
    shakaRef,
    stallTimer,
    started,
    stopActiveTorrent,
    streamIdentityRef,
    video,
  } = ctx;
  /* ----------------------------------------------------------------- audio */

  const destroyAttachedPlayers = () => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
    const sp = shakaRef.current;
    shakaRef.current = null;
    dashHeightsRef.current = [];
    if (sp) void sp.destroy().catch(() => {});
  };
  /**
   * Leaving the player (or moving to a web player, which drops the <video>): stop the element's own
   * download too. A detached video with a plain file or torrent URL keeps fetching until it is
   * garbage-collected. A switch between our own streams skips this: the next attach resets it.
   */
  const releaseMediaIfUnmounted = (v: HTMLVideoElement) => {
    if (mountedRef.current && v.isConnected) return;
    try {
      v.pause();
      v.removeAttribute("src");
      v.load();
    } catch {
      /* already gone */
    }
  };

  /** On a dual-audio stream, play the track that matches sub (Japanese) or dub (English). */
  const pickAudioTrack = () => {
    if (manualAudio.current) return;
    const hls = hlsRef.current;
    if (hls && hls.audioTracks.length > 1) {
      const i = preferredAudioTrackIndex(hls.audioTracks, audio, originalLanguage);
      if (i >= 0) {
        if (i !== hls.audioTrack) hls.audioTrack = i;
        setSelectedAudioTrack(i);
      }
      return;
    }
    const sp = shakaRef.current;
    if (sp) {
      const dashAudio = sp.getAudioTracks();
      if (dashAudio.length > 1) {
        const i = preferredAudioTrackIndex(
          dashAudio.map((t) => ({ name: t.label ?? undefined, lang: t.language })),
          audio,
          originalLanguage,
        );
        if (i >= 0 && dashAudio[i]) {
          if (!dashAudio[i].active) sp.selectAudioTrack(dashAudio[i]);
          setSelectedAudioTrack(i);
        }
      }
      return;
    }
    const tracks = (video.current as (HTMLVideoElement & { audioTracks?: ArrayLike<{ language?: string; enabled: boolean }> }) | null)?.audioTracks;
    if (tracks && tracks.length > 1) {
      const found = preferredAudioTrackIndex(Array.from(tracks, (track) => ({ lang: track.language })), audio, originalLanguage);
      if (found >= 0) {
        for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === found;
        setSelectedAudioTrack(found);
      } else {
        setSelectedAudioTrack(Array.from(tracks).findIndex((track) => track.enabled));
      }
    }
  };
  const chooseAudioTrack = (id: number) => {
    const hls = hlsRef.current;
    const sp = shakaRef.current;
    if (localAudioModeRef.current && curRef.current?.localPath) {
      if (id === selectedAudioTrack) return;
      // Prepare (or reuse) the copy with this track, and pick up where the viewer was.
      const v = video.current;
      manualAudio.current = true;
      localAudioRef.current = id;
      if (v && v.currentTime > 1) resumeAt.current = v.currentTime;
      keepPausedRef.current = Boolean(v?.paused && v.currentTime > 1);
      setSelectedAudioTrack(id);
      flash(`Audio: ${audioTracks.find((t) => t.id === id)?.label ?? `Track ${id + 1}`} · preparing…`);
      setRetrySeq((n) => n + 1);
      return;
    }
    if (hls?.audioTracks[id]) {
      manualAudio.current = true;
      hls.audioTrack = id;
    } else if (sp) {
      const dashAudio = sp.getAudioTracks();
      if (!dashAudio[id]) return;
      manualAudio.current = true;
      sp.selectAudioTrack(dashAudio[id]);
    } else {
      const tracks = (video.current as (HTMLVideoElement & { audioTracks?: ArrayLike<{ enabled: boolean }> }) | null)?.audioTracks;
      if (!tracks?.[id]) return;
      manualAudio.current = true;
      for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === id;
    }
    setSelectedAudioTrack(id);
    flash(`Audio: ${audioTracks.find((t) => t.id === id)?.label ?? `Track ${id + 1}`}`);
  };

  // WebViews that expose embedded tracks can switch them directly; HLS tracks are handled above.
  useEffect(() => {
    const v = video.current;
    if (!v || cur?.kind !== "file") return;

    type NativeAudioTrack = { label?: string; language?: string; enabled: boolean };
    type NativeAudioTrackList = ArrayLike<NativeAudioTrack> & EventTarget;
    const nativeVideo = v as HTMLVideoElement & { audioTracks?: NativeAudioTrackList };
    let audioList: NativeAudioTrackList | undefined;

    const refreshAudio = () => {
      // The list comes from the file itself (probe_local_audio): the WebView's empty one mustn't replace it.
      if (localAudioModeRef.current) return;
      const next = nativeVideo.audioTracks;
      if (next !== audioList) {
        audioList?.removeEventListener("addtrack", refreshAudio);
        audioList?.removeEventListener("removetrack", refreshAudio);
        audioList?.removeEventListener("change", refreshAudio);
        audioList = next;
        audioList?.addEventListener("addtrack", refreshAudio);
        audioList?.addEventListener("removetrack", refreshAudio);
        audioList?.addEventListener("change", refreshAudio);
      }
      const tracks = Array.from(audioList ?? []);
      setAudioTracks(tracks.map((track, i) => ({
        id: i,
        label: track.label || track.language || `Track ${i + 1}`,
        lang: track.language || "und",
      })));
      const enabled = tracks.findIndex((track) => track.enabled);
      setSelectedAudioTrack(enabled);
      if (!manualAudio.current && tracks.length > 1) pickAudioTrack();
    };

    const refreshSubtitles = () => {
      if (hlsRef.current) {
        for (let i = 0; i < v.textTracks.length; i++) {
          if (v.textTracks[i].mode === "showing") v.textTracks[i].mode = "hidden";
        }
        return;
      }
      const activeCur = curRef.current;
      const hasEmbeddedCandidate =
        (activeCur?.providerId === "local" || activeCur?.providerId === "downloads") &&
        Boolean(activeCur.subtitles?.some((t) => t.source === "embedded" || t.streamIndex != null || t.url.startsWith("embedded://")));
      if (hasEmbeddedCandidate) {
        for (let i = 0; i < v.textTracks.length; i++) {
          if (v.textTracks[i].mode !== "disabled") v.textTracks[i].mode = "disabled";
        }
        setNativeSubs([]);
        return;
      }
      const currentPrim = selectedSubRef.current;
      const currentSec = secondarySubRef.current;
      const tracks: UnifiedSubTrack[] = [];
      for (let i = 0; i < v.textTracks.length; i++) {
        const track = v.textTracks[i];
        if (track.kind !== "subtitles" && track.kind !== "captions") continue;
        const id = `native-sub-${i}`;
        const isSelected = id === currentPrim || id === currentSec;
        if (track.mode === "showing") {
          track.mode = isSelected ? "hidden" : "disabled";
        } else if (!isSelected && track.mode !== "disabled") {
          track.mode = "disabled";
        }
        tracks.push({
          id,
          label: track.label || track.language || `Track ${i + 1}`,
          lang: track.language || "und",
          origin: "native" as const,
          nativeTrack: track,
        });
      }
      setNativeSubs(tracks);
    };

    v.addEventListener("loadedmetadata", refreshAudio);
    v.textTracks.addEventListener("addtrack", refreshSubtitles);
    v.textTracks.addEventListener("removetrack", refreshSubtitles);
    v.textTracks.addEventListener("change", refreshSubtitles);
    refreshAudio();
    refreshSubtitles();
    return () => {
      v.removeEventListener("loadedmetadata", refreshAudio);
      v.textTracks.removeEventListener("addtrack", refreshSubtitles);
      v.textTracks.removeEventListener("removetrack", refreshSubtitles);
      v.textTracks.removeEventListener("change", refreshSubtitles);
      audioList?.removeEventListener("addtrack", refreshAudio);
      audioList?.removeEventListener("removetrack", refreshAudio);
      audioList?.removeEventListener("change", refreshAudio);
    };
  }, [cur?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --------------------------------------------------------------- watchdog */

  // A server that passed its checks can still fail to start or stall for good mid-episode.
  // Then move on to the next one at the same spot instead of spinning forever.
  const START_TIMEOUT = 20_000;
  const STALL_TIMEOUT = 15_000;
  const armStall = useCallback(() => {
    clearStall();
    const v = video.current;
    if (!v || (v.paused && started.current)) return;
    stallTimer.current = window.setTimeout(() => {
      const vv = video.current;
      // Still not playing, not paused by the viewer, and no data arriving.
      if (vv && !(vv.paused && started.current) && vv.readyState < 3) failover(started.current ? "stalled" : "didn't start");
    }, started.current ? STALL_TIMEOUT : START_TIMEOUT);
  }, [clearStall, failover]);
  const armStallRef = useRef(armStall);
  armStallRef.current = armStall;
  useEffect(() => {
    if (!cur || cur.kind === "embed" || preparingLocal || preparingTorrent) return;
    started.current = false;
    setHasStarted(false);
    armStall();
    return clearStall;
  }, [cur?.url, cur?.kind, preparingLocal, preparingTorrent, retrySeq, armStall, clearStall]);

  /* ---------------------------------------------------------- attach source */

  const lastRefreshedAtRef = useRef(new Map<string, number>());

  useEffect(() => {
    const c = curRef.current;
    if (!c) return;
    activeSessionRef.current += 1;
    attachStartRef.current = performance.now();
    started.current = false;
    setHasStarted(false);
    setPlaying(false);
    setLiveStreamId(null);
    setRecovering(false);
    setFatal(null);
    setEnded(false);
    setPreparingLocal(false);
    setPreparingTorrent(false);
    stopActiveTorrent();
    setAudioTracks([]);
    // A token refresh of the same stream keeps the viewer's audio pick (re-applied once tracks list).
    const sameStream = !!streamIdentityRef.current && attachIdentityRef.current === streamIdentityRef.current;
    attachIdentityRef.current = streamIdentityRef.current;
    if (!sameStream) {
      setSelectedAudioTrack(-1);
      manualAudio.current = false;
      keepPausedRef.current = false;
      localAudioRef.current = null;
    }
    localAudioModeRef.current = false;
    setLevels([]);
    setLevel(-1);
    setActiveLevel(-1);
    setVideoHeight(undefined);
    setTime(0);
    setDur(0);
    destroyAttachedPlayers();
    refreshCtlRef.current?.abort();
    refreshCtlRef.current = null;
    if (c.kind === "embed") {
      setWaiting(true);
      embedPos.current = { time: resumeAt.current, duration: 0 };
      setEmbedClock({ time: 0, duration: 0 });
      return;
    }
    const v = video.current;
    if (!v) return;
    setWaiting(true);
    // Reset any previous stream immediately so the upscaler never reads stale readyState/dimensions
    // while hls.js or local media preparation loads asynchronously, and enforce anonymous CORS.
    v.pause();
    v.removeAttribute("src");
    v.crossOrigin = "anonymous";
    v.load();

    const seekAndPlay = () => {
      if (resumeAt.current > 0 && resumeAt.current < (v.duration || Infinity) - 5) v.currentTime = resumeAt.current;
      pickAudioTrack();
      // A refreshed link for a paused video stays paused at the same spot.
      if (keepPausedRef.current) {
        keepPausedRef.current = false;
        return;
      }
      v.play().catch(() => {});
    };
    let cancelled = false;
    const refreshExpiredStream = (
      target: StreamCandidate,
      fallbackMsg: string,
      httpCode: number | undefined,
      disposeCurrent: () => void,
    ) => {
      const targetId = candKey(target);
      lastRefreshedAtRef.current.set(targetId, Date.now());
      if (v.currentTime > 1) resumeAt.current = v.currentTime;
      keepPausedRef.current = v.paused && v.currentTime > 1;
      saveNowRef.current();
      clearStall();
      setWaiting(true);
      flash(`Refreshing ${target.providerName} stream link…`);

      disposeCurrent();

      refreshCtlRef.current?.abort();
      const refreshCtl = new AbortController();
      refreshCtlRef.current = refreshCtl;

      void session
        .refresh(targetId, refreshCtl.signal)
        .then((refreshed) => {
          if (cancelled || refreshCtl.signal.aborted || !mountedRef.current) return;
          if (refreshCtlRef.current === refreshCtl) refreshCtlRef.current = null;
          if (!refreshed?.probe?.ok) {
            failover(refreshed?.probe?.error ?? (httpCode ? `HTTP ${httpCode}` : fallbackMsg));
            return;
          }
          if (refreshed.url === target.url) {
            attachStream(refreshed);
            armStallRef.current();
          }
        })
        .catch((err: unknown) => {
          if (cancelled || refreshCtl.signal.aborted || !mountedRef.current) return;
          if (refreshCtlRef.current === refreshCtl) refreshCtlRef.current = null;
          failover(err instanceof Error ? err.message : "stream token refresh failed");
        });
    };
    const loadFile = (url: string) => {
      if (cancelled) return;
      v.crossOrigin = "anonymous";
      v.src = url;
      v.addEventListener("loadedmetadata", seekAndPlay, { once: true });
    };
    const attachHls = (H: typeof Hls, streamUrl: string, target: StreamCandidate) => {
      if (cancelled) return;
      v.crossOrigin = "anonymous";
      if (!H.isSupported()) {
        v.src = streamUrl;
        v.addEventListener("loadedmetadata", seekAndPlay, { once: true });
        return;
      }
      const hls = new H({
        enableWorker: true,
        lowLatencyMode: false,
        startFragPrefetch: true,
        capLevelToPlayerSize: false,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        backBufferLength: 30,
        fragLoadingMaxRetry: 4,
        manifestLoadingMaxRetry: 3,
        levelLoadingMaxRetry: 3,
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        },
      });
      hlsRef.current = hls;
      hls.subtitleDisplay = false;
      let recoveries = 0;
      let lastRecoveryAt = 0;
      let midStreamRefreshing = false;
      let lastNetErrCode: number | undefined;
      initPtsRef.current = null;
      hls.on(H.Events.INIT_PTS_FOUND, (_, d) => {
        if (initPtsRef.current == null && d.initPTS != null && d.timescale) initPtsRef.current = d.initPTS / d.timescale;
      });
      hls.on(H.Events.MANIFEST_PARSED, (_, d) => {
        if (cancelled) return;
        lastNetErrCode = undefined;
        const pref = getSettings().preferredQuality;
        if (pref > 0 && d.levels.length > 1) {
          let bestWithin = -1;
          let bestWithinH = -1;
          let closestAbove = -1;
          let closestAboveH = Infinity;
          d.levels.forEach((lvl, idx) => {
            const h = lvl.height || 0;
            if (!h) return;
            if (h <= pref && h > bestWithinH) {
              bestWithinH = h;
              bestWithin = idx;
            } else if (h > pref && h < closestAboveH) {
              closestAboveH = h;
              closestAbove = idx;
            }
          });
          const startIdx = bestWithin >= 0 ? bestWithin : closestAbove;
          if (startIdx >= 0) {
            hls.startLevel = startIdx;
          }
        }
        setHlsReady(true);
        setLevels(d.levels.map((l) => ({ height: l.height })));
        seekAndPlay();
      });
      hls.on(H.Events.FRAG_LOADED, () => {
        lastNetErrCode = undefined;
        // Repairs are for a burst of trouble: after 15 s of healthy playback the budget is restored,
        // so three isolated hiccups across a long film don't add up to a failover.
        if (recoveries && performance.now() - lastRecoveryAt > 15_000) recoveries = 0;
      });
      hls.on(H.Events.LEVEL_SWITCHED, (_, d) => {
        setActiveLevel(d.level);
      });
      hls.on(H.Events.AUDIO_TRACKS_UPDATED, (_, d) => {
        setAudioTracks((d.audioTracks ?? []).map((t, i) => ({
          id: i,
          label: t.name || t.lang || `Track ${i + 1}`,
          lang: t.lang ?? "und",
        })));
        setSelectedAudioTrack(hls.audioTrack);
        pickAudioTrack();
      });
      hls.on(H.Events.AUDIO_TRACK_SWITCHED, (_, d) => setSelectedAudioTrack(d.id));
      hls.on(H.Events.SUBTITLE_TRACKS_UPDATED, (_, d) => {
        setHlsSubs(
          (d.subtitleTracks ?? []).map((t, i) => ({
            id: `hls-${i}`,
            label: t.name || t.lang || `Track ${i + 1}`,
            lang: t.lang ?? "und",
            origin: "hls" as const,
            isDefault: Boolean(t.default),
            isForced: Boolean(t.forced),
            hlsIndex: i,
          })),
        );
      });
      hls.on(H.Events.SUBTITLE_FRAG_PROCESSED, () => {
        evaluateCuesRef.current();
      });
      hls.on(H.Events.ERROR, (_, d) => {
        if (cancelled) return;
        const netStatus =
          d.networkDetails && typeof d.networkDetails === "object" && "status" in d.networkDetails
            ? Number((d.networkDetails as { status?: number }).status)
            : undefined;
        const code = d.response?.code ?? (netStatus && Number.isFinite(netStatus) && netStatus > 0 ? netStatus : undefined);
        if (d.type === H.ErrorTypes.NETWORK_ERROR && code) {
          lastNetErrCode = code;
        }
        if (!d.fatal) return;

        // Media errors get two local repair attempts (the second also swaps the audio codec), then the next source.
        if (d.type === H.ErrorTypes.MEDIA_ERROR && recoveries < 2) {
          lastRecoveryAt = performance.now();
          if (recoveries++ === 1) hls.swapAudioCodec();
          hls.recoverMediaError();
          return;
        }

        const httpCode = code ?? (d.type === H.ErrorTypes.NETWORK_ERROR ? lastNetErrCode : undefined);
        const isAuthOrExpired =
          httpCode === 401 ||
          httpCode === 403 ||
          httpCode === 410 ||
          isUrlTokenExpired(target.url) ||
          (typeof d.url === "string" && isUrlTokenExpired(d.url));
        const targetId = candKey(target);
        const lastRefresh = lastRefreshedAtRef.current.get(targetId) ?? 0;

        if (
          d.type === H.ErrorTypes.NETWORK_ERROR &&
          isAuthOrExpired &&
          target.pageUrl &&
          !midStreamRefreshing &&
          Date.now() - lastRefresh >= 60_000
        ) {
          midStreamRefreshing = true;
          refreshExpiredStream(target, d.details, httpCode, () => {
            if (hlsRef.current === hls) hlsRef.current = null;
            hls.destroy();
          });
          return;
        }

        failover(httpCode ? `${d.details} (${httpCode})` : d.details);
      });
      hls.loadSource(streamUrl);
      hls.attachMedia(v);
    };
    const attachDash = (shakaMod: typeof shaka, streamUrl: string, target: StreamCandidate) => {
      if (cancelled) return;
      v.crossOrigin = "anonymous";
      shakaMod.polyfill?.installAll?.();
      if (!shakaMod.Player.isBrowserSupported()) {
        failover("DASH playback is not supported in this browser");
        return;
      }
      const player = new shakaMod.Player();
      shakaRef.current = player;
      const collector = new DashCueCollector((cues) => {
        const id = dashSubIdRef.current;
        if (cancelled || !id || shakaRef.current !== player) return;
        patchTrackData(activeCurUrlRef.current, id, { cues, format: "vtt", loading: false });
      });
      dashCollectorRef.current = collector;
      dashSubIdRef.current = null;
      player.configure({
        streaming: {
          bufferingGoal: 60,
          rebufferingGoal: 2,
          bufferBehind: 30,
        },
        abr: { enabled: true },
        // Shaka parses the DASH text tracks; our renderer draws them (styling, dual subs, timing).
        textDisplayFactory: () => collector as unknown as shaka.extern.TextDisplayer,
      });

      const syncDashTracks = () => {
        if (cancelled || shakaRef.current !== player) return;
        const variants = player.getVariantTracks();
        const heights = Array.from(
          new Set(variants.map((t) => t.height ?? 0).filter((h) => h > 0)),
        ).sort((a, b) => a - b);
        dashHeightsRef.current = heights;
        setLevels(heights.map((height) => ({ height })));
        const activeVar = variants.find((t) => t.active);
        setActiveLevel(activeVar?.height ? heights.indexOf(activeVar.height) : -1);

        const dashAudio = player.getAudioTracks();
        setAudioTracks(
          dashAudio.map((t, i) => ({
            id: i,
            label: t.label || t.language || `Track ${i + 1}`,
            lang: t.language || "und",
          })),
        );
        const activeAudioIdx = dashAudio.findIndex((t) => t.active);
        if (activeAudioIdx >= 0) setSelectedAudioTrack(activeAudioIdx);

        setHlsSubs(
          player.getTextTracks().map((t, i) => ({
            id: `dash-${t.id}`,
            label: t.label || t.language || `Track ${i + 1}`,
            lang: t.language || "und",
            origin: "dash" as const,
            isDefault: Boolean(t.primary),
            isForced: Boolean(t.forced),
            dashTrackId: t.id,
          })),
        );
      };

      player.addEventListener("trackschanged", () => {
        syncDashTracks();
        pickAudioTrack();
      });
      player.addEventListener("adaptation", () => {
        if (cancelled || shakaRef.current !== player) return;
        const activeVar = player.getVariantTracks().find((t) => t.active);
        const heights = dashHeightsRef.current;
        setActiveLevel(activeVar?.height ? heights.indexOf(activeVar.height) : -1);
      });

      let dashDead = false;
      const handleDashError = (rawErr: unknown, fromEvent: boolean) => {
        if (cancelled || dashDead) return;
        const err = rawErr as Partial<shaka.util.Error> | undefined;
        const code = typeof err?.code === "number" ? err.code : undefined;
        if (code === shakaMod.util.Error.Code.LOAD_INTERRUPTED) return;
        if (fromEvent && err?.severity !== shakaMod.util.Error.Severity.CRITICAL) return;

        const errData = Array.isArray(err?.data) ? (err.data as unknown[]) : undefined;
        const httpCode =
          code === shakaMod.util.Error.Code.BAD_HTTP_STATUS && errData && typeof errData[1] === "number"
            ? errData[1]
            : undefined;
        const errUrl = errData && typeof errData[0] === "string" ? errData[0] : undefined;
        const isAuthOrExpired =
          httpCode === 401 ||
          httpCode === 403 ||
          httpCode === 410 ||
          isUrlTokenExpired(target.url) ||
          (errUrl ? isUrlTokenExpired(errUrl) : false);
        const targetId = candKey(target);
        const lastRefresh = lastRefreshedAtRef.current.get(targetId) ?? 0;

        dashDead = true;
        if (
          isAuthOrExpired &&
          target.pageUrl &&
          Date.now() - lastRefresh >= 60_000
        ) {
          refreshExpiredStream(target, `DASH error ${code ?? "unknown"}`, httpCode, () => {
            if (shakaRef.current === player) {
              shakaRef.current = null;
              dashHeightsRef.current = [];
            }
            void player.destroy().catch(() => {});
          });
          return;
        }
        failover(httpCode ? `DASH error ${code ?? "network"} (${httpCode})` : `DASH error ${code ?? "playback"}`);
      };

      player.addEventListener("error", (ev) => {
        handleDashError((ev as Event & { detail?: unknown }).detail, true);
      });

      void (async () => {
        try {
          await player.attach(v);
          if (cancelled || shakaRef.current !== player) {
            await player.destroy().catch(() => {});
            return;
          }
          await player.load(streamUrl);
          if (cancelled || shakaRef.current !== player) return;
          setHlsReady(true);
          syncDashTracks();
          seekAndPlay();
        } catch (err: unknown) {
          handleDashError(err, false);
        }
      })();
    };
    const attachStream = (target: StreamCandidate) => {
      // hls.js (~600 kB) and shaka-player are dynamically loaded only for HLS / DASH streams.
      if (target.kind === "hls") {
        // playbackUrl: the zero-copy loopback gateway when reachable, else the abxs: proxy as-is.
        import("hls.js").then((m) => attachHls(m.default, playbackUrl(target.url), target), () => !cancelled && failover("player failed to load"));
      } else if (target.kind === "dash") {
        const isAlreadyProxied = unwrapProxyUrl(target.url).proxied;
        const isLocalProxy = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(target.url);
        const dashUrl =
          native && !isAlreadyProxied && !isLocalProxy && /^https?:/i.test(target.url) && (target.headers || target.pageUrl)
            ? proxyUrl(target.url, target.headers, target.pageUrl)
            : target.url;
        import("shaka-player").then(
          (m) => attachDash(((m as { default?: typeof shaka }).default ?? m) as typeof shaka, playbackUrl(dashUrl), target),
          () => !cancelled && failover("DASH player failed to load"),
        );
      } else if (/^magnet:/i.test(target.url.trim())) {
        const magnetUri = target.url.trim();
        if (!isTauri()) {
          setWaiting(false);
          failover("torrent playback requires the desktop app");
          return;
        }
        setPreparingTorrent(true);
        const rawFileIdx = (target as { fileIdx?: unknown }).fileIdx;
        const fileIdx = typeof rawFileIdx === "number" && Number.isFinite(rawFileIdx) ? rawFileIdx : null;
        void (async () => {
          try {
            const supported = await invoke<boolean>("torrent_is_supported").catch(() => false);
            if (cancelled) return;
            if (!supported) {
              setPreparingTorrent(false);
              setWaiting(false);
              failover("torrent streaming is not enabled in this build");
              return;
            }
            const info = await invoke<unknown>("torrent_start_stream", {
              magnetOrHash: magnetUri,
              fileIdx,
            });
            const rec = info && typeof info === "object" ? (info as Record<string, unknown>) : null;
            const streamId = rec && typeof rec.id === "number" && Number.isFinite(rec.id) ? rec.id : null;
            const streamUrl =
              typeof info === "string"
                ? info.trim()
                : typeof rec?.url === "string"
                  ? rec.url.trim()
                  : typeof rec?.streamUrl === "string"
                    ? rec.streamUrl.trim()
                    : typeof rec?.stream_url === "string"
                      ? rec.stream_url.trim()
                      : "";
            if (cancelled) {
              if (streamId != null) {
                void invoke("torrent_stop", { id: streamId }).catch(() => {});
              }
              return;
            }
            if (!/^https?:\/\//i.test(streamUrl)) {
              if (streamId != null) {
                void invoke("torrent_stop", { id: streamId }).catch(() => {});
              }
              setPreparingTorrent(false);
              setWaiting(false);
              failover("torrent stream returned an invalid URL");
              return;
            }
            activeTorrentIdRef.current = streamId;
            setPreparingTorrent(false);
            loadFile(streamUrl);
          } catch (error: unknown) {
            if (cancelled) return;
            setPreparingTorrent(false);
            setWaiting(false);
            failover(`torrent stream failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        })();
      } else if (target.localPath) {
        setPreparingLocal(true);
        const localPath = target.localPath;
        const audioIndex = localAudioRef.current;
        invoke<string>("prepare_local_media", { path: localPath, ...(audioIndex != null ? { audioIndex } : {}) })
          .then((path) => {
            if (cancelled) return;
            setPreparingLocal(false);
            loadFile(convertFileSrc(path));
            // Offer the file's audio tracks (WebView2 can't list or switch them itself).
            invoke<{ index: number; codec: string; channels?: number; language?: string; title?: string; isDefault: boolean }[]>(
              "probe_local_audio",
              { path: localPath },
            )
              .then((list) => {
                if (cancelled || list.length < 2) return;
                localAudioModeRef.current = true;
                setAudioTracks(
                  list.map((a) => {
                    const ch = a.channels === 6 ? " 5.1" : a.channels === 8 ? " 7.1" : a.channels === 1 ? " mono" : "";
                    const base = a.title || (a.language ? langLabel(a.language) : `Track ${a.index + 1}`);
                    return { id: a.index, label: `${base}${ch}`, lang: a.language ?? "und" };
                  }),
                );
                setSelectedAudioTrack(audioIndex ?? Math.max(0, list.findIndex((a) => a.isDefault)));
              })
              .catch(() => {});
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            setPreparingLocal(false);
            setWaiting(false);
            failover(`audio conversion failed: ${error instanceof Error ? error.message : String(error)}`);
          });
      } else {
        loadFile(playbackUrl(target.url));
      }
    };
    // Re-validate and refresh stale/expired stream URLs before playback.
    const candidateId = candKey(c);
    const lastPreRefresh = lastRefreshedAtRef.current.get(candidateId) ?? 0;
    if (c.pageUrl && isUrlTokenExpired(c.url) && Date.now() - lastPreRefresh >= 60_000) {
      lastRefreshedAtRef.current.set(candidateId, Date.now());
      const refreshCtl = new AbortController();
      refreshCtlRef.current = refreshCtl;
      // The session swaps in the fresh link, which re-runs this effect with the new URL.
      void session
        .refresh(candidateId, refreshCtl.signal)
        .then((refreshed) => {
          if (cancelled || refreshCtl.signal.aborted || !mountedRef.current) return;
          if (refreshCtlRef.current === refreshCtl) refreshCtlRef.current = null;
          if (!refreshed?.probe?.ok) {
            failover(refreshed?.probe?.error ?? "expired stream");
            return;
          }
          if (refreshed.url === c.url) {
            attachStream(refreshed);
          }
        })
        .catch((err: unknown) => {
          if (cancelled || refreshCtl.signal.aborted || !mountedRef.current) return;
          if (refreshCtlRef.current === refreshCtl) refreshCtlRef.current = null;
          failover(err instanceof Error ? err.message : "expired stream refresh failed");
        });
      return () => {
        cancelled = true;
        refreshCtl.abort();
        if (refreshCtlRef.current === refreshCtl) refreshCtlRef.current = null;
        v.removeEventListener("loadedmetadata", seekAndPlay);
        if (v.currentTime > 1) resumeAt.current = v.currentTime;
        stopActiveTorrent();
        destroyAttachedPlayers();
        releaseMediaIfUnmounted(v);
      };
    }
    attachStream(c);
    return () => {
      cancelled = true;
      refreshCtlRef.current?.abort();
      refreshCtlRef.current = null;
      v.removeEventListener("loadedmetadata", seekAndPlay);
      if (v.currentTime > 1) resumeAt.current = v.currentTime;
      stopActiveTorrent();
      destroyAttachedPlayers();
      releaseMediaIfUnmounted(v);
    };
  }, [cur?.url, cur?.kind, cur?.localPath, retrySeq, failover, clearStall, stopActiveTorrent]); // eslint-disable-line react-hooks/exhaustive-deps

  return { armStall, chooseAudioTrack };
}

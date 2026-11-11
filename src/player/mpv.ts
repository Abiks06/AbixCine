import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { Settings } from "../lib/settings";
import type { StreamCandidate } from "../sources/types";

/**
 * mpv as a second playback engine (see src-tauri/src/mpv.rs for the native half).
 *
 * MpvMedia looks like an HTMLMediaElement to the Player: the same properties (currentTime,
 * duration, paused, volume…) and the same events (play, pause, waiting, playing, timeupdate,
 * durationchange, loadedmetadata, ended, error), so the Player's logic doesn't care which engine
 * is drawing the picture.
 */

export interface MpvInfo {
  path: string;
  version: string;
  bundled: boolean;
}

export interface MpvTrack {
  id: number;
  type: "video" | "audio" | "sub";
  lang?: string;
  title?: string;
  codec?: string;
  channels?: number;
  selected: boolean;
  external: boolean;
}

export interface MpvChapter {
  title: string;
  time: number;
}

export type Engine = "html" | "mpv";

// ---------- availability ----------

let probe: { path: string; p: Promise<MpvInfo | null> } | null = null;
let known: MpvInfo | null | undefined;
const watchers = new Set<() => void>();

/** Find mpv (bundled copy, the path from Settings, PATH, scoop/winget/Program Files). Cached per path. */
export function probeMpv(path = "", force = false): Promise<MpvInfo | null> {
  if (!isTauri()) return Promise.resolve(null);
  if (!force && probe && probe.path === path) return probe.p;
  const p = invoke<MpvInfo | null>("mpv_probe", { path: path || null })
    .catch(() => null)
    .then((r) => {
      known = r;
      watchers.forEach((w) => w());
      return r;
    });
  probe = { path, p };
  return p;
}

/** undefined while checking, null when mpv isn't installed. */
export function useMpv(path: string): MpvInfo | null | undefined {
  const [, tick] = useState(0);
  useEffect(() => {
    const w = () => tick((n) => n + 1);
    watchers.add(w);
    void probeMpv(path);
    return () => {
      watchers.delete(w);
    };
  }, [path]);
  return probe?.path === path ? known : undefined;
}

// ---------- engine choice ----------

/** Which engine should play this candidate? */
export function engineFor(c: StreamCandidate | undefined, s: Pick<Settings, "engine">, mpv: MpvInfo | null | undefined): Engine {
  if (!c || !mpv) return "html";
  if (s.engine === "builtin") return "html";
  if (s.engine === "mpv") return "mpv";
  return c.needsMpv ? "mpv" : "html";
}

/** The address mpv opens: the original file/stream when the provider has one, else the same URL. */
export const mpvTarget = (c: StreamCandidate) => c.nativeUrl ?? c.url;

/** Preferred audio/subtitle languages for mpv's automatic track pick. */
export function trackLangs(audio?: "sub" | "dub"): { alang?: string; slang?: string } {
  if (audio === "sub") return { alang: "jpn,ja,jp", slang: "eng,en" };
  if (audio === "dub") return { alang: "eng,en", slang: "eng,en" };
  return {};
}

// ---------- the media shim ----------

interface StartOpts {
  path?: string;
  embedded: boolean;
  hwdec: boolean;
  alang?: string;
  slang?: string;
  title?: string;
}

let reqId = 1000;

export class MpvMedia extends EventTarget {
  private session = -1;
  private early: { session: number; msg: any }[] = [];
  private unlisten: UnlistenFn[] = [];
  private started: Promise<MpvInfo> | null = null;
  private loaded = false;
  private ended = false;
  private stopped = false;
  private time = 0;
  private dur = 0;
  private cache = 0;
  private vol = 1;
  private mute = false;
  private rate = 1;
  private isPaused = true;
  private buffering = false;
  private seekingNow = false;
  private pendingPlay = true;
  embedded = false;
  tracks: MpvTrack[] = [];
  chapters: MpvChapter[] = [];
  sid: number | null = null;
  aid: number | null = null;
  videoHeight = 0;
  lastError: string | null = null;

  /** Launch mpv (idle). Safe to call more than once. */
  start(opts: StartOpts): Promise<MpvInfo> {
    this.started ??= (async () => {
      this.unlisten.push(
        await listen<{ session: number; msg: any }>("mpv-event", (e) => {
          // Events can land before mpv_start returns our session id: hold them until it does.
          if (this.session === -1) this.early.push(e.payload);
          else if (e.payload.session === this.session) this.onMessage(e.payload.msg);
        }),
        await listen<{ session: number }>("mpv-exit", (e) => {
          if (e.payload.session !== this.session || this.stopped) return;
          this.lastError = "mpv closed";
          this.emit("error");
          this.emit("exit");
        }),
      );
      const info = await invoke<MpvInfo & { session: number; embedded: boolean }>("mpv_start", { opts: { ...opts, path: opts.path || null } });
      this.session = info.session;
      this.embedded = info.embedded;
      this.early.filter((x) => x.session === info.session).forEach((x) => this.onMessage(x.msg));
      this.early = [];
      this.emit("started");
      return info;
    })();
    return this.started;
  }

  private onMessage(m: any) {
    if (m.event === "property-change") return this.onProp(m.name, m.data);
    switch (m.event) {
      case "start-file":
        this.loaded = false;
        this.ended = false;
        this.buffering = true;
        this.emit("waiting");
        break;
      case "file-loaded":
        this.loaded = true;
        this.emit("loadedmetadata");
        this.emit("canplay");
        break;
      case "playback-restart":
        this.seekingNow = false;
        this.buffering = false;
        if (!this.isPaused) this.emit("playing");
        else this.emit("canplay");
        break;
      case "end-file":
        if (m.reason === "error") {
          this.lastError = m.file_error || "mpv couldn't open this";
          this.emit("error");
        }
        break;
    }
  }

  private onProp(name: string, v: any) {
    switch (name) {
      case "time-pos":
        if (typeof v === "number") {
          this.time = v;
          this.emit("timeupdate");
        }
        break;
      case "duration":
        if (typeof v === "number" && v !== this.dur) {
          this.dur = v;
          this.emit("durationchange");
        }
        break;
      case "pause":
        this.isPaused = !!v;
        this.emit(v ? "pause" : "play");
        if (!v && !this.buffering) this.emit("playing");
        break;
      case "paused-for-cache":
      case "seeking": {
        if (name === "seeking") this.seekingNow = !!v;
        const was = this.buffering;
        this.buffering = !!v || this.seekingNow;
        if (this.buffering && !was) this.emit("waiting");
        else if (!this.buffering && was && !this.isPaused) this.emit("playing");
        break;
      }
      case "eof-reached":
        if (v === true && !this.ended && this.loaded) {
          this.ended = true;
          this.emit("ended");
        }
        break;
      case "demuxer-cache-time":
        if (typeof v === "number") this.cache = v;
        break;
      case "volume":
        if (typeof v === "number") this.vol = v / 100;
        break;
      case "mute":
        this.mute = !!v;
        break;
      case "speed":
        if (typeof v === "number") this.rate = v;
        break;
      case "track-list":
        this.tracks = (Array.isArray(v) ? v : []).map((t: any) => ({
          id: t.id,
          type: t.type,
          lang: t.lang,
          title: t.title,
          codec: t.codec,
          channels: t["demux-channel-count"],
          selected: !!t.selected,
          external: !!t.external,
        }));
        this.emit("tracks");
        break;
      case "sid":
        this.sid = typeof v === "number" ? v : null;
        this.emit("tracks");
        break;
      case "aid":
        this.aid = typeof v === "number" ? v : null;
        this.emit("tracks");
        break;
      case "video-params":
        this.videoHeight = v?.h ?? 0;
        this.emit("resize");
        break;
      case "chapter-list":
        this.chapters = (Array.isArray(v) ? v : []).map((c: any) => ({ title: String(c.title ?? ""), time: Number(c.time) || 0 }));
        this.emit("chapters");
        break;
    }
  }

  private emit(type: string) {
    this.dispatchEvent(new Event(type));
  }

  command(...args: (string | number | boolean)[]) {
    return invoke("mpv_command", { args, requestId: reqId++ }).catch((e) => {
      this.lastError = String(e);
    });
  }

  /** Open a file or stream, starting at `startAt` seconds. Plays unless `autoplay` is false. */
  async load(target: string, startAt = 0, autoplay = true) {
    this.loaded = false;
    this.ended = false;
    this.time = startAt > 0 ? startAt : 0;
    this.pendingPlay = autoplay;
    await this.command("set_property", "start", startAt > 0 ? String(Math.floor(startAt)) : "none");
    await this.command("set_property", "pause", !autoplay);
    await this.command("loadfile", target, "replace");
  }

  // ---- HTMLMediaElement-like surface ----
  get currentTime() {
    return this.time;
  }
  set currentTime(t: number) {
    this.time = t;
    void this.command("seek", Math.max(0, t), "absolute");
    this.emit("timeupdate");
  }
  get duration() {
    return this.dur || NaN;
  }
  get paused() {
    return this.isPaused;
  }
  get volume() {
    return this.vol;
  }
  set volume(v: number) {
    this.vol = v;
    void this.command("set_property", "volume", Math.round(v * 100));
  }
  get muted() {
    return this.mute;
  }
  set muted(m: boolean) {
    this.mute = m;
    void this.command("set_property", "mute", m);
  }
  get playbackRate() {
    return this.rate;
  }
  set playbackRate(r: number) {
    if (r === this.rate) return;
    this.rate = r;
    void this.command("set_property", "speed", r);
  }
  get readyState() {
    return this.loaded ? 4 : 0;
  }
  get bufferedEnd() {
    return Math.min(this.dur || Infinity, this.time + this.cache);
  }
  get wantsPlay() {
    return this.pendingPlay;
  }
  play() {
    this.pendingPlay = true;
    return this.command("set_property", "pause", false).then(() => undefined);
  }
  pause() {
    this.pendingPlay = false;
    void this.command("set_property", "pause", true);
  }
  setSubtitle(id: number | null) {
    void this.command("set_property", "sid", id == null ? "no" : id);
  }
  setAudio(id: number) {
    void this.command("set_property", "aid", id);
  }
  addSubtitle(url: string, title?: string, lang?: string) {
    void this.command("sub-add", url, "auto", title ?? "", lang ?? "");
  }

  /** Quit mpv and hide its window. */
  async destroy() {
    this.stopped = true;
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
    await invoke("mpv_stop").catch(() => {});
  }
}

/** Label a track for menus: "English · AC3 5.1", "Japanese (Signs & Songs)". */
export function trackLabel(t: MpvTrack) {
  const lang = t.lang ? languageName(t.lang) : "";
  const ch = t.channels ? (t.channels >= 8 ? "7.1" : t.channels >= 6 ? "5.1" : t.channels === 2 ? "stereo" : t.channels === 1 ? "mono" : `${t.channels}ch`) : "";
  const tech = t.type === "audio" ? [t.codec?.toUpperCase(), ch].filter(Boolean).join(" ") : "";
  const main = [lang, t.title && t.title !== lang ? t.title : ""].filter(Boolean).join(" · ") || `Track ${t.id}`;
  return tech ? `${main} · ${tech}` : main;
}

const LANGS: Record<string, string> = {
  en: "English", eng: "English", ja: "Japanese", jpn: "Japanese", jp: "Japanese", fr: "French", fre: "French", fra: "French",
  de: "German", ger: "German", deu: "German", es: "Spanish", spa: "Spanish", it: "Italian", ita: "Italian", pt: "Portuguese",
  por: "Portuguese", ko: "Korean", kor: "Korean", zh: "Chinese", chi: "Chinese", zho: "Chinese", ru: "Russian", rus: "Russian",
  ar: "Arabic", ara: "Arabic", hi: "Hindi", hin: "Hindi", und: "",
};
const languageName = (code: string) => LANGS[code.toLowerCase()] ?? code;

/** Chapters that are an opening/ending/recap, for "Skip intro" on files that mark them. */
export function skippableChapters(chapters: MpvChapter[], duration: number): { start: number; end: number; type: "op" | "ed" | "recap" }[] {
  const out: { start: number; end: number; type: "op" | "ed" | "recap" }[] = [];
  chapters.forEach((c, i) => {
    const t = c.title.trim().toLowerCase();
    const type = /^(op|opening|intro|introduction|opening (song|credits|theme))\b/.test(t)
      ? "op"
      : /^(ed|ending|outro|credits|end credits|ending (song|credits|theme))\b/.test(t)
        ? "ed"
        : /^(recap|previously)\b/.test(t)
          ? "recap"
          : null;
    if (!type) return;
    const end = chapters[i + 1]?.time ?? duration;
    if (end - c.time > 5 && end - c.time < 400) out.push({ start: c.time, end, type });
  });
  return out;
}

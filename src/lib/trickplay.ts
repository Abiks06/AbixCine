/**
 * Scrub previews: a frame of the film above the progress bar where you point.
 *
 * A hidden, muted second player is opened on the first hover (never otherwise) and seeks to the
 * point under the pointer: for HLS it plays the lowest-quality level with a 2-second buffer, for
 * files it reads the file itself. One seek runs at a time, always to the newest request, and frames
 * are cached per 5-second bucket as small JPEGs, so moving back over a stretch costs nothing.
 */
const BUCKET_SEC = 5;
const THUMB_W = 192;
const THUMB_H = 108;
const MAX_CACHE = 300;
const SEEK_TIMEOUT_MS = 6000;

type HlsCtor = typeof import("hls.js").default;

export class TrickplayEngine {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private hls: InstanceType<HlsCtor> | null = null;
  private cache = new Map<number, string>();
  private busy = false;
  private wanted: { bucket: number; resolve: (v: string | null) => void }[] = [];
  private ready: Promise<boolean>;
  private disposed = false;

  constructor(kind: "hls" | "file", url: string) {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.preload = "metadata";
    this.video.crossOrigin = "anonymous";
    this.video.playsInline = true;
    this.canvas = document.createElement("canvas");
    this.canvas.width = THUMB_W;
    this.canvas.height = THUMB_H;
    this.ready = kind === "hls" ? this.openHls(url) : this.openFile(url);
  }

  private openFile(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        this.video.removeEventListener("loadedmetadata", onOk);
        this.video.removeEventListener("error", onErr);
        resolve(ok);
      };
      const onOk = () => done(true);
      const onErr = () => done(false);
      this.video.addEventListener("loadedmetadata", onOk);
      this.video.addEventListener("error", onErr);
      this.video.src = url;
    });
  }

  private async openHls(url: string): Promise<boolean> {
    try {
      const H = (await import("hls.js")).default;
      if (this.disposed || !H.isSupported()) return false;
      const hls = new H({
        startLevel: 0,
        capLevelToPlayerSize: false,
        maxBufferLength: 2,
        maxMaxBufferLength: 4,
        backBufferLength: 0,
        enableWorker: true,
        // A preview never needs subtitles.
        renderTextTracksNatively: false,
      });
      hls.subtitleDisplay = false;
      this.hls = hls;
      return await new Promise<boolean>((resolve) => {
        hls.on(H.Events.MANIFEST_PARSED, () => {
          hls.currentLevel = 0; // lowest quality: previews are tiny
          resolve(true);
        });
        hls.on(H.Events.ERROR, (_, d) => {
          if (d.fatal) resolve(false);
        });
        hls.loadSource(url);
        hls.attachMedia(this.video);
      });
    } catch {
      return false;
    }
  }

  /** A frame near `t` seconds as a data URL, or null when one can't be had. */
  frameAt(t: number): Promise<string | null> {
    if (this.disposed || !Number.isFinite(t)) return Promise.resolve(null);
    const bucket = Math.max(0, Math.floor(t / BUCKET_SEC));
    const hit = this.cache.get(bucket);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      // Only the newest request matters: older ones are answered with null.
      for (const w of this.wanted) w.resolve(null);
      this.wanted = [{ bucket, resolve }];
      void this.pump();
    });
  }

  private async pump() {
    if (this.busy || this.disposed) return;
    const job = this.wanted.shift();
    if (!job) return;
    this.busy = true;
    try {
      const ok = await this.ready;
      const url = ok ? await this.capture(job.bucket * BUCKET_SEC + BUCKET_SEC / 2) : null;
      if (url) {
        this.cache.set(job.bucket, url);
        if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
      }
      job.resolve(url);
    } catch {
      job.resolve(null);
    } finally {
      this.busy = false;
      if (this.wanted.length) void this.pump();
    }
  }

  private capture(t: number): Promise<string | null> {
    const v = this.video;
    const target = v.duration ? Math.min(Math.max(0, t), v.duration - 0.5) : t;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (val: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        v.removeEventListener("seeked", onSeeked);
        resolve(val);
      };
      const draw = () => {
        try {
          const ctx = this.canvas.getContext("2d");
          if (!ctx || !v.videoWidth) return finish(null);
          ctx.drawImage(v, 0, 0, THUMB_W, THUMB_H);
          finish(this.canvas.toDataURL("image/jpeg", 0.62));
        } catch {
          finish(null); // a tainted (non-CORS) frame can't be read back
        }
      };
      const onSeeked = () => {
        // The decoded frame is ready on the next video frame callback (or right away without one).
        const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
        if (rvfc) rvfc.call(v, draw);
        else draw();
      };
      const timer = setTimeout(() => finish(null), SEEK_TIMEOUT_MS);
      v.addEventListener("seeked", onSeeked);
      v.currentTime = target;
    });
  }

  dispose() {
    this.disposed = true;
    for (const w of this.wanted) w.resolve(null);
    this.wanted = [];
    try {
      this.hls?.destroy();
    } catch {
      /* already gone */
    }
    this.hls = null;
    this.video.removeAttribute("src");
    try {
      this.video.load();
    } catch {
      /* ignore */
    }
    this.cache.clear();
  }
}

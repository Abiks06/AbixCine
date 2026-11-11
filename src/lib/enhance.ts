/// <reference types="@webgpu/types" />
/**
 * Picture enhancement with Anime4K (https://github.com/bloc97/Anime4K), through its WebGPU
 * port. The video keeps decoding in its <video>; each new frame is copied to a GPU texture,
 * run through an Anime4K chain and drawn to a canvas laid over it.
 *
 * Built to stay inside the frame budget:
 * - fast "M" networks by default (the library presets use the ~3× heavier "VL" ones);
 * - upscale only when the screen is meaningfully bigger than the video, otherwise restore only;
 * - never queue work: if the GPU is still busy when a frame arrives, that frame is skipped
 *   instead of building a backlog (which is what makes playback lag);
 * - a governor measures real GPU time per frame and steps down a tier if it can't keep up;
 * - the chain is rebuilt for the new size on fullscreen/resize, and idles while hidden.
 */

export type EnhanceMode = "off" | "clarity" | "a" | "b" | "c" | "aa";

export const ENHANCE_MODES: { id: EnhanceMode; name: string; hint: string; heavy?: boolean }[] = [
  { id: "off", name: "Off", hint: "Original picture" },
  { id: "clarity", name: "Clarity", hint: "Line sharpening only. Lightest; good for films and series" },
  { id: "a", name: "Anime4K A", hint: "Restore + upscale when needed. Best all-round for anime" },
  { id: "b", name: "Anime4K B", hint: "Softer restore for 720p or heavily compressed anime" },
  { id: "c", name: "Anime4K C", hint: "Pure upscale for low-resolution sources (480p, 720p)" },
  { id: "aa", name: "Anime4K A · High quality", hint: "Heavier networks. Needs a strong GPU", heavy: true },
];

/** What the governor steps down to when a mode can't keep up. */
const FALLBACK: Record<Exclude<EnhanceMode, "off">, EnhanceMode> = { aa: "a", a: "clarity", b: "clarity", c: "clarity", clarity: "off" };

export const webgpuAvailable = () => typeof navigator !== "undefined" && "gpu" in navigator;

type Lib = typeof import("anime4k-webgpu");
let lib: Promise<Lib> | null = null;
/** The shaders are ~3.5 MB, so they load the first time enhancement is turned on. */
const loadLib = () => (lib ??= import("anime4k-webgpu"));

/** One GPU device for the whole session: creating a device is slow and leaks if repeated. */
let devicePromise: Promise<GPUDevice> | null = null;
function getDevice(): Promise<GPUDevice> {
  devicePromise ??= navigator.gpu.requestAdapter({ powerPreference: "high-performance" }).then((a) => {
    if (!a) throw new Error("No WebGPU adapter");
    // Timestamp queries give true per-frame GPU time for the governor (when the GPU has them).
    return a.requestDevice({ requiredFeatures: a.features.has("timestamp-query") ? ["timestamp-query"] : [] });
  });
  devicePromise.then((d) => d.lost.then(() => (devicePromise = null))).catch(() => (devicePromise = null));
  return devicePromise;
}

const VERT = /* wgsl */ `
struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var o: Out;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, 1.0 - (p[i].y + 1.0) * 0.5);
  return o;
}`;
const FRAG = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(textureSample(tex, samp, uv).rgb, 1.0);
}`;

export interface EnhancerStats {
  mode: EnhanceMode;
  /** Average GPU time per processed frame. */
  gpuMs: number;
  /** Frames skipped because the GPU was still busy. */
  skipped: number;
  /** "restore" | "restore + 2× upscale" … for the UI. */
  chain: string;
}

export interface Enhancer {
  stop(): void;
  stats(): EnhancerStats;
}

export interface EnhancerOptions {
  /** Called when the governor steps down (the new mode, possibly "off"). */
  onDowngrade?: (to: EnhanceMode, why: string) => void;
}

type Pipe = import("anime4k-webgpu").Anime4KPipeline;

/**
 * Build the chain for a mode. The 2× network only runs for sub-900p sources on a screen at
 * least 1.25× bigger: doubling a 1080p frame (to fill a high-DPI display) is the single most
 * expensive step and barely visible, so 1080p+ sources are restored at native size instead.
 */
function buildChain(A: Lib, device: GPUDevice, input: GPUTexture, mode: Exclude<EnhanceMode, "off">, native: { width: number; height: number }, target: { width: number; height: number }) {
  const needsUp = native.height < 900 && target.width > native.width * 1.25 && target.height > native.height * 1.25;
  const pipes: Pipe[] = [];
  const add = (p: Pipe) => (pipes.push(p), p.getOutputTexture());
  let tex = input;
  if (mode === "clarity") {
    add(new A.DoG({ device, inputTexture: tex }));
    return { pipes, chain: "line sharpening" };
  }
  if (mode === "aa") {
    tex = add(new A.ClampHighlights({ device, inputTexture: tex }));
    tex = add(new A.CNNVL({ device, inputTexture: tex }));
    if (needsUp) add(new A.CNNx2VL({ device, inputTexture: tex }));
    return { pipes, chain: needsUp ? "HQ restore + 2× upscale" : "HQ restore" };
  }
  if (mode === "c") {
    // Low-res sources: the upscale network does the work; a restore pass first would be wasted.
    if (needsUp) {
      add(new A.CNNx2M({ device, inputTexture: tex }));
      return { pipes, chain: "2× upscale" };
    }
    add(new A.CNNM({ device, inputTexture: tex }));
    return { pipes, chain: "restore" };
  }
  tex = add(mode === "b" ? new A.CNNSoftM({ device, inputTexture: tex }) : new A.CNNM({ device, inputTexture: tex }));
  if (needsUp) add(new A.CNNx2M({ device, inputTexture: tex }));
  return { pipes, chain: needsUp ? `${mode === "b" ? "soft restore" : "restore"} + 2× upscale` : mode === "b" ? "soft restore" : "restore" };
}

/**
 * Start enhancing `video` into `canvas`. Resolves once the first frame is set up; throws when
 * WebGPU is unavailable or the frame can't be read (e.g. a cross-origin stream without CORS).
 */
export async function startEnhancer(video: HTMLVideoElement, canvas: HTMLCanvasElement, startMode: Exclude<EnhanceMode, "off">, opts: EnhancerOptions = {}): Promise<Enhancer> {
  if (!webgpuAvailable()) throw new Error("This PC's graphics driver doesn't expose WebGPU");
  if (video.readyState < 2 || !video.videoWidth) {
    await new Promise<void>((resolve) => video.addEventListener("loadeddata", () => resolve(), { once: true }));
  }
  const [A, device] = await Promise.all([loadLib(), getDevice()]);
  const ctx = canvas.getContext("webgpu");
  if (!ctx) throw new Error("WebGPU canvas unavailable");
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });

  const render = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: device.createShaderModule({ code: VERT }), entryPoint: "vs" },
    fragment: { module: device.createShaderModule({ code: FRAG }), entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

  // GPU timing: an empty compute pass stamps the start, another the end, around the chain.
  const timing = device.features.has("timestamp-query");
  const qset = timing ? device.createQuerySet({ type: "timestamp", count: 2 }) : null;
  const qbuf = timing ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
  const rbuf = timing ? device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : null;
  let reading = false;

  let mode = startMode;
  let graceUntil = 0;
  let lastStep = 0;
  let input = null as GPUTexture | null;
  let pipes: Pipe[] = [];
  let bind: GPUBindGroup | null = null;
  let chain = "";
  let w = 0;
  let h = 0;

  /** Size the canvas to the picture's on-screen size (contain-fit, device pixels) and build the chain. */
  const setup = () => {
    // New shaders compile on their first frames: judge the chain only after it settles.
    graceUntil = performance.now() + 2500;
    w = video.videoWidth;
    h = video.videoHeight;
    const box = canvas.parentElement!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(box.width / w, box.height / h) * dpr;
    const target = { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
    canvas.width = target.width;
    canvas.height = target.height;
    input?.destroy();
    input = device.createTexture({
      size: [w, h, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const built = buildChain(A, device, input, mode as Exclude<EnhanceMode, "off">, { width: w, height: h }, target);
    pipes = built.pipes;
    chain = built.chain;
    // Draw at the chain's output size when that's smaller than the screen area: the compositor
    // scales the canvas for free, while a full-screen 4K render pass costs a real GPU slice.
    const out = pipes[pipes.length - 1].getOutputTexture();
    if (out.width < canvas.width) {
      canvas.width = out.width;
      canvas.height = out.height;
    }
    bind = device.createBindGroup({
      layout: render.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: pipes[pipes.length - 1].getOutputTexture().createView() },
      ],
    });
  };
  setup();

  // A stream served without CORS can't be read by the GPU; say so instead of drawing black.
  try {
    device.queue.copyExternalImageToTexture({ source: video }, { texture: input! }, [w, h]);
  } catch {
    input?.destroy();
    throw new Error("This stream doesn't allow picture processing");
  }

  let running = true;
  let handle = 0;
  /** Frames submitted but not yet finished. Two may overlap: the GPU runs them in order, and
   *  waiting for each to be confirmed before starting the next wastes a whole IPC round trip. */
  let inflight = 0;
  const MAX_INFLIGHT = 2;
  let skipped = 0;
  let processed = 0;
  /** Skips/processed over the current governor window. */
  let winSkips = 0;
  let winFrames = 0;
  let gpuEma = 0;
  let winStartMedia = 0;
  let frames = 0;
  /** Budget per frame from the video's own frame rate (falls back to 24 fps). */
  let frameBudget = 1000 / 24;
  let lastMediaTime = 0;

  const process = () => {
    if (!input || !bind) return;
    try {
      device.queue.copyExternalImageToTexture({ source: video }, { texture: input }, [w, h]);
    } catch {
      return; // a frame that can't be read (mid-seek) is skipped
    }
    const enc = device.createCommandEncoder();
    const stamp = qset && !reading;
    if (stamp) enc.beginComputePass({ timestampWrites: { querySet: qset!, beginningOfPassWriteIndex: 0 } }).end();
    for (const p of pipes) p.pass(enc);
    if (stamp) {
      enc.beginComputePass({ timestampWrites: { querySet: qset!, endOfPassWriteIndex: 1 } }).end();
      enc.resolveQuerySet(qset!, 0, 2, qbuf!, 0);
      enc.copyBufferToBuffer(qbuf!, 0, rbuf!, 0, 16);
    }
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
    });
    pass.setPipeline(render);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    const t0 = performance.now();
    inflight++;
    processed++;
    device.queue.submit([enc.finish()]);
    device.queue.onSubmittedWorkDone().then(async () => {
      inflight--;
      let ms = performance.now() - t0; // fallback: includes GPU-process round trip, so it overstates
      if (stamp && running) {
        reading = true;
        try {
          await rbuf!.mapAsync(GPUMapMode.READ);
          const t = new BigUint64Array(rbuf!.getMappedRange().slice(0));
          rbuf!.unmap();
          if (t[1] > t[0]) ms = Number(t[1] - t[0]) / 1e6;
        } catch {
          /* keep the wall-clock estimate */
        }
        reading = false;
      }
      gpuEma = gpuEma ? gpuEma * 0.85 + ms * 0.15 : ms;
      govern();
    });
  };

  /**
   * Step down a tier when the chain can't keep up for about two seconds: GPU time above ~95% of
   * the video's frame interval (when it can be measured), or more than a third of frames
   * skipped because the GPU was still busy.
   */
  const govern = () => {
    const mt = video.currentTime;
    if (++frames < 15 || performance.now() < graceUntil || video.paused || video.seeking) {
      winStartMedia = mt;
      winFrames = winSkips = 0;
      return;
    }
    winFrames++;
    // Throughput: frames we processed vs frames the video advanced through, over ~3 s of playback.
    // This is what the viewer sees, and unlike counting skips it doesn't undercount when a
    // saturated GPU also slows the video's own frame delivery.
    const span = mt - winStartMedia;
    if (span < 3 || span > 30) {
      if (span > 30 || span < 0) (winStartMedia = mt), (winFrames = winSkips = 0);
      return;
    }
    const expected = (span * 1000) / frameBudget;
    const ratio = winFrames / Math.max(1, expected);
    winStartMedia = mt;
    winFrames = winSkips = 0;
    const behind = ratio < 0.8;
    if (!behind) return;
    // At most one step down every 10 s: give the new chain a fair chance.
    if (performance.now() - lastStep < 10_000) return;
    lastStep = performance.now();
    const why = `only ${Math.round(ratio * 100)}% of frames kept up${timing ? `, ${gpuEma.toFixed(0)} ms GPU per ${Math.round(frameBudget)} ms frame` : ""}`;
    frames = 0;
    gpuEma = 0;
    const next = FALLBACK[mode as Exclude<EnhanceMode, "off">];
    if (next === "off") {
      opts.onDowngrade?.("off", why);
      return;
    }
    mode = next;
    setup();
    opts.onDowngrade?.(next, why);
  };

  const frame: VideoFrameRequestCallback = (_now, meta) => {
    if (!running) return;
    if (lastMediaTime && meta.mediaTime > lastMediaTime) {
      const dt = (meta.mediaTime - lastMediaTime) * 1000;
      if (dt > 8 && dt < 70) frameBudget = frameBudget * 0.9 + (dt / (video.playbackRate || 1)) * 0.1;
    }
    lastMediaTime = meta.mediaTime;
    // Hidden window: nothing to show. Busy GPU: drop this frame rather than queue it.
    if (document.hidden) {
      /* idle */
    } else if (inflight >= MAX_INFLIGHT) {
      skipped++;
      winSkips++;
    }
    else process();
    handle = video.requestVideoFrameCallback(frame);
  };
  // Paint the current frame right away (covers a paused video), then follow new frames.
  process();
  handle = video.requestVideoFrameCallback(frame);

  // Fullscreen / window resize: rebuild for the new on-screen size (debounced).
  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (!running) return;
      setup();
      if (inflight < MAX_INFLIGHT) process();
    }, 250);
  });
  ro.observe(canvas.parentElement!);
  // Seeking while paused produces no new video frame callback on some sources: repaint.
  const onSeeked = () => inflight < MAX_INFLIGHT && process();
  video.addEventListener("seeked", onSeeked);

  return {
    stop() {
      running = false;
      video.cancelVideoFrameCallback(handle);
      video.removeEventListener("seeked", onSeeked);
      ro.disconnect();
      clearTimeout(resizeTimer);
      input?.destroy();
      input = null;
      qset?.destroy();
      qbuf?.destroy();
      if (!reading) rbuf?.destroy();
      try {
        ctx.unconfigure();
      } catch {
        /* already gone */
      }
    },
    stats: () => ({ mode, gpuMs: Math.round(gpuEma * 10) / 10, skipped, chain }),
  };
}

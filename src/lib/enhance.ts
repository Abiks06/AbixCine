/// <reference types="@webgpu/types" />
/**
 * Picture enhancement with Anime4K (https://github.com/bloc97/Anime4K), through its WebGPU
 * port, with an automatic WebGL2 Contrast-Adaptive Sharpening (CAS) fallback when WebGPU is
 * unavailable and graceful fallback to native <video> playback on context loss or CORS errors.
 *
 * Built to stay inside the frame budget:
 * - fast "M" networks by default (the library presets use the ~3× heavier "VL" ones);
 * - upscale only when the screen is meaningfully bigger than the video, otherwise restore only;
 * - never queue work: if the GPU is still busy when a frame arrives, that frame is skipped
 *   instead of building a backlog (which is what makes playback lag);
 * - a governor measures real GPU time per frame and steps down a tier if it can't keep up;
 * - the chain is rebuilt for the new size on fullscreen/resize AND on adaptive stream resolution
 *   changes (HLS/DASH level switches), and idles while hidden.
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
const FALLBACK: Record<Exclude<EnhanceMode, "off">, EnhanceMode> = {
  aa: "a",
  a: "clarity",
  b: "clarity",
  c: "clarity",
  clarity: "off",
};

export const webgpuAvailable = () => typeof navigator !== "undefined" && "gpu" in navigator;

export const webgl2Available = () => {
  if (typeof document === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
};

export const upscalerAvailable = () => webgpuAvailable() || webgl2Available();

type Lib = typeof import("anime4k-webgpu");
let lib: Promise<Lib> | null = null;
/** The shaders are ~3.5 MB, so they load the first time enhancement is turned on. */
const loadLib = () =>
  (lib ??= import("anime4k-webgpu").catch((err) => {
    lib = null;
    throw err;
  }));

/** One GPU device for the whole session: creating a device is slow and leaks if repeated. */
let devicePromise: Promise<GPUDevice> | null = null;
function getDevice(): Promise<GPUDevice> {
  if (!webgpuAvailable()) return Promise.reject(new Error("No WebGPU support"));
  devicePromise ??= navigator.gpu
    .requestAdapter({ powerPreference: "high-performance" })
    .then((a) => {
      if (!a) throw new Error("No WebGPU adapter");
      // Timestamp queries give true per-frame GPU time for the governor (when the GPU has them).
      return a.requestDevice({
        requiredFeatures: a.features.has("timestamp-query") ? ["timestamp-query"] : [],
      });
    });
  devicePromise
    .then((d) =>
      d.lost.then(() => {
        devicePromise = null;
      }),
    )
    .catch(() => {
      devicePromise = null;
    });
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

const GL2_VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID == 2) ? 3.0 : -1.0, (gl_VertexID == 0) ? -3.0 : 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
  vUv = vec2((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
}`;

/** Contrast-Adaptive Sharpening (CAS) fragment shader for WebGL2 fallback. */
const GL2_FRAG = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uSharpness;
out vec4 fragColor;
void main() {
  vec3 e = texture(uTex, vUv).rgb;
  if (uSharpness <= 0.01) {
    fragColor = vec4(e, 1.0);
    return;
  }
  vec3 b = texture(uTex, vUv + vec2(0.0, -uTexel.y)).rgb;
  vec3 d = texture(uTex, vUv + vec2(-uTexel.x, 0.0)).rgb;
  vec3 f = texture(uTex, vUv + vec2(uTexel.x, 0.0)).rgb;
  vec3 h = texture(uTex, vUv + vec2(0.0, uTexel.y)).rgb;
  vec3 mn = min(min(min(d, e), min(f, b)), h);
  vec3 mx = max(max(max(d, e), max(f, b)), h);
  vec3 amp = clamp(min(mn, 2.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0);
  amp = sqrt(amp);
  vec3 w = -amp * (0.125 + 0.075 * uSharpness);
  vec3 outCol = clamp((b * w + d * w + f * w + h * w + e) / (1.0 + 4.0 * w), 0.0, 1.0);
  fragColor = vec4(outCol, 1.0);
}`;

export interface EnhancerStats {
  mode: EnhanceMode;
  /** Average GPU time per processed frame. */
  gpuMs: number;
  /** Frames skipped because the GPU was still busy. */
  skipped: number;
  /** "restore" | "restore + 2× upscale" … for the UI. */
  chain: string;
  /** Active graphics pipeline backend. */
  backend?: "webgpu" | "webgl2";
}

export interface Enhancer {
  stop(): void;
  stats(): EnhancerStats;
}

export interface EnhancerOptions {
  /** Optional AbortSignal to cancel enhancer initialization cleanly before startup finishes. */
  signal?: AbortSignal;
  /** Called when the governor steps down (the new mode, possibly "off"). */
  onDowngrade?: (to: EnhanceMode, why: string) => void;
  /** Called when GPU context is lost, shaders fail at runtime, or CORS blocks frame access. */
  onFallback?: (why: string) => void;
}

type Pipe = import("anime4k-webgpu").Anime4KPipeline;

function destroyPipe(p: unknown) {
  if (!p || typeof p !== "object") return;
  const rec = p as Record<string, unknown>;
  try {
    if (typeof rec.getOutputTexture === "function") {
      (rec.getOutputTexture() as GPUTexture | undefined)?.destroy?.();
    }
  } catch {
    /* ignore */
  }
  try {
    (rec.outputTexture as GPUTexture | undefined)?.destroy?.();
  } catch {
    /* ignore */
  }
  if (Array.isArray(rec.textures)) {
    for (const t of rec.textures) {
      try {
        (t as GPUTexture | undefined)?.destroy?.();
      } catch {
        /* ignore */
      }
    }
  }
  try {
    (rec.strengthBuffer as GPUBuffer | undefined)?.destroy?.();
  } catch {
    /* ignore */
  }
  if (Array.isArray(rec.pipelines)) {
    for (const sub of rec.pipelines) destroyPipe(sub);
  }
}

function destroyChain(pipes: Pipe[]) {
  for (const p of pipes) destroyPipe(p);
}

/**
 * Wait until `video` has decoded at least one frame with non-zero dimensions (`videoWidth > 0`
 * and `videoHeight > 0`), cleaning up all temporary listeners immediately if `signal` aborts.
 */
function waitForVideoReady(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        cleanup();
        resolve();
      }
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("loadedmetadata", check);
      video.removeEventListener("canplay", check);
      video.removeEventListener("resize", check);
      signal?.removeEventListener("abort", onAbort);
    };
    video.addEventListener("loadeddata", check);
    video.addEventListener("loadedmetadata", check);
    video.addEventListener("canplay", check);
    video.addEventListener("resize", check);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isSecurityOrCorsError(err: unknown): boolean {
  if (!err) return false;
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "SecurityError") {
    return true;
  }
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /security|tainted|cross-origin|cors/i.test(msg);
}

/**
 * Compute target canvas pixel dimensions that preserve the video's exact aspect ratio (`w / h`)
 * while fitting inside `canvas.parentElement` at devicePixelRatio and staying within `maxDim`.
 */
function computeTargetSize(canvas: HTMLCanvasElement, w: number, h: number, maxDim: number): { width: number; height: number } {
  const box = canvas.parentElement?.getBoundingClientRect();
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  const boxW = box && box.width > 0 ? box.width : w;
  const boxH = box && box.height > 0 ? box.height : h;
  const fitScale = Math.min(boxW / w, boxH / h) * dpr;
  const maxScale = maxDim / Math.max(w, h, 1);
  const scale = Math.min(maxScale, Math.max(1, fitScale));
  return {
    width: Math.max(1, Math.min(maxDim, Math.round(w * scale))),
    height: Math.max(1, Math.min(maxDim, Math.round(h * scale))),
  };
}

/**
 * Build the chain for a mode. The 2× network only runs for sub-900p sources on a screen at
 * least 1.25× bigger: doubling a 1080p frame (to fill a high-DPI display) is the single most
 * expensive step and barely visible, so 1080p+ sources are restored at native size instead.
 */
function buildChain(
  A: Lib,
  device: GPUDevice,
  input: GPUTexture,
  mode: Exclude<EnhanceMode, "off">,
  native: { width: number; height: number },
  target: { width: number; height: number },
) {
  const maxDim = device.limits?.maxTextureDimension2D ?? 4096;
  const canDouble = native.width * 2 <= maxDim && native.height * 2 <= maxDim;
  const needsUp =
    canDouble &&
    native.height < 900 &&
    target.width > native.width * 1.25 &&
    target.height > native.height * 1.25;
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
  return {
    pipes,
    chain: needsUp ? `${mode === "b" ? "soft restore" : "restore"} + 2× upscale` : mode === "b" ? "soft restore" : "restore",
  };
}

/** Schedule the next video frame callback with a requestAnimationFrame fallback. */
function scheduleFrame(video: HTMLVideoElement, cb: VideoFrameRequestCallback): { id: number; rvfc: boolean } {
  if (typeof video.requestVideoFrameCallback === "function") {
    return { id: video.requestVideoFrameCallback(cb), rvfc: true };
  }
  const id = window.requestAnimationFrame((now) =>
    cb(now, {
      mediaTime: video.currentTime,
      presentedFrames: 0,
      expectedDisplayTime: now + 16.67,
      width: video.videoWidth,
      height: video.videoHeight,
      presentationTime: now,
    }),
  );
  return { id, rvfc: false };
}

function cancelFrame(video: HTMLVideoElement, token: { id: number; rvfc: boolean } | null) {
  if (!token || !token.id) return;
  if (token.rvfc && typeof video.cancelVideoFrameCallback === "function") {
    video.cancelVideoFrameCallback(token.id);
  } else {
    window.cancelAnimationFrame(token.id);
  }
}

/**
 * WebGL2 CAS fallback pipeline when WebGPU is unavailable on the user's GPU/driver.
 * Supports adaptive resolution sync, WebGL context loss detection, and CORS protection.
 */
function startWebGL2Enhancer(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  startMode: Exclude<EnhanceMode, "off">,
  opts: EnhancerOptions,
): Enhancer {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    powerPreference: "high-performance",
  });
  if (!gl || gl.isContextLost()) throw new Error("WebGPU and WebGL2 are unavailable on this graphics driver");

  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type);
    if (!sh) throw new Error("Failed to allocate WebGL2 shader");
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`WebGL2 shader compile error: ${info}`);
    }
    return sh;
  };

  const vs = compile(gl.VERTEX_SHADER, GL2_VERT);
  let fs: WebGLShader;
  try {
    fs = compile(gl.FRAGMENT_SHADER, GL2_FRAG);
  } catch (err) {
    gl.deleteShader(vs);
    throw err;
  }
  const prog = gl.createProgram();
  if (!prog) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error("Failed to allocate WebGL2 program");
  }
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`WebGL2 program link error: ${info}`);
  }

  const vao = gl.createVertexArray();
  const tex = gl.createTexture();
  if (!vao || !tex || gl.isContextLost()) {
    if (tex) gl.deleteTexture(tex);
    if (vao) gl.deleteVertexArray(vao);
    gl.deleteProgram(prog);
    throw new Error("Failed to allocate WebGL2 resources (context lost)");
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const uTex = gl.getUniformLocation(prog, "uTex");
  const uTexel = gl.getUniformLocation(prog, "uTexel");
  const uSharpness = gl.getUniformLocation(prog, "uSharpness");
  const maxDim = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096;

  let mode = startMode;
  let w = 0;
  let h = 0;
  let running = true;
  let frameToken: { id: number; rvfc: boolean } | null = null;
  let consecutiveErrors = 0;
  let gpuEma = 0;

  const sharpnessFor = (m: Exclude<EnhanceMode, "off">) =>
    m === "aa" ? 1.0 : m === "a" ? 0.8 : m === "c" ? 0.7 : m === "b" ? 0.5 : 0.6;

  const setup = (): boolean => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return false;
    w = vw;
    h = vh;
    const target = computeTargetSize(canvas, w, h, maxDim);
    canvas.width = target.width;
    canvas.height = target.height;
    gl.viewport(0, 0, canvas.width, canvas.height);
    return true;
  };

  if (!setup()) {
    gl.deleteTexture(tex);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(prog);
    throw new Error("Video frame dimensions unavailable");
  }

  // Test initial texture upload so CORS-tainted streams fail fast before hiding <video>.
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  } catch (err) {
    gl.deleteTexture(tex);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(prog);
    throw new Error(
      isSecurityOrCorsError(err)
        ? "Cross-origin stream doesn't allow GPU frame access (CORS)"
        : "This stream doesn't allow picture processing",
    );
  }

  const triggerFallback = (why: string) => {
    if (!running) return;
    stop();
    opts.onFallback?.(why);
  };

  const process = () => {
    if (!running || gl.isContextLost()) return;
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    if (video.videoWidth !== w || video.videoHeight !== h) {
      if (!setup()) return;
    }
    const t0 = performance.now();
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      consecutiveErrors = 0;
    } catch (err) {
      if (isSecurityOrCorsError(err)) {
        triggerFallback("Cross-origin stream blocked GPU access — playing native video");
        return;
      }
      if (++consecutiveErrors >= 8 && !video.seeking && !video.paused) {
        triggerFallback("Video frame capture failed — switched to native video");
      }
      return;
    }

    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(uTex, 0);
    gl.uniform2f(uTexel, 1 / w, 1 / h);
    gl.uniform1f(uSharpness, sharpnessFor(mode));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const ms = performance.now() - t0;
    gpuEma = gpuEma ? gpuEma * 0.85 + ms * 0.15 : ms;
  };

  const frame: VideoFrameRequestCallback = () => {
    if (!running) return;
    if (!document.hidden) process();
    if (running) frameToken = scheduleFrame(video, frame);
  };

  process();
  if (running) frameToken = scheduleFrame(video, frame);

  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (!running) return;
      if (setup()) process();
    }, 200);
  });
  if (canvas.parentElement) ro.observe(canvas.parentElement);

  const onVideoResize = () => {
    if (!running) return;
    if (setup()) process();
  };
  const onSeeked = () => {
    if (running) process();
  };
  const onContextLost = (e: Event) => {
    e.preventDefault();
    triggerFallback("WebGL context lost — switched to native video");
  };

  video.addEventListener("resize", onVideoResize);
  video.addEventListener("seeked", onSeeked);
  canvas.addEventListener("webglcontextlost", onContextLost);

  const stop = () => {
    if (!running) return;
    running = false;
    cancelFrame(video, frameToken);
    frameToken = null;
    video.removeEventListener("resize", onVideoResize);
    video.removeEventListener("seeked", onSeeked);
    canvas.removeEventListener("webglcontextlost", onContextLost);
    ro.disconnect();
    clearTimeout(resizeTimer);
    try {
      if (!gl.isContextLost()) {
        gl.deleteTexture(tex);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(prog);
      }
    } catch {
      /* ignore teardown errors */
    }
    canvas.width = 0;
    canvas.height = 0;
  };

  return {
    stop,
    stats: () => ({
      mode,
      gpuMs: Math.round(gpuEma * 10) / 10,
      skipped: 0,
      chain: "CAS sharpen (WebGL2)",
      backend: "webgl2",
    }),
  };
}

/**
 * Start enhancing `video` into `canvas`. Resolves once the first frame is set up; falls back to
 * WebGL2 CAS when WebGPU is unavailable, or throws when neither GPU pipeline can read the stream.
 */
export async function startEnhancer(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  startMode: Exclude<EnhanceMode, "off">,
  opts: EnhancerOptions = {},
): Promise<Enhancer> {
  if (!upscalerAvailable()) {
    throw new Error("This PC's graphics driver doesn't expose WebGPU or WebGL2");
  }

  // Ensure anonymous CORS mode is configured before any frame texture bind when no media has loaded yet.
  if (!video.crossOrigin && !video.currentSrc && !video.src) {
    video.crossOrigin = "anonymous";
  }

  await waitForVideoReady(video, opts.signal);
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");

  // Try WebGPU first; if WebGPU adapter/device acquisition fails, fall back cleanly to WebGL2 BEFORE
  // calling canvas.getContext("webgpu") (since a canvas element locks to its first context type).
  let A: Lib | null = null;
  let device: GPUDevice | null = null;
  if (webgpuAvailable()) {
    try {
      [A, device] = await Promise.all([loadLib(), getDevice()]);
    } catch {
      A = null;
      device = null;
    }
  }
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");

  if (!A || !device) {
    return startWebGL2Enhancer(video, canvas, startMode, opts);
  }

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
  let rbuf = timing ? device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : null;
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
  let inflight = 0;
  const retired: { pipes: Pipe[]; input: GPUTexture | null }[] = [];
  const maxDim = device.limits?.maxTextureDimension2D ?? 4096;

  const releaseResources = (oldPipes: Pipe[], oldInput: GPUTexture | null) => {
    if (!oldPipes.length && !oldInput) return;
    if (inflight > 0) {
      retired.push({ pipes: oldPipes, input: oldInput });
      return;
    }
    destroyChain(oldPipes);
    try {
      oldInput?.destroy();
    } catch {
      /* ignore */
    }
  };

  const flushRetired = () => {
    if (inflight > 0 || !retired.length) return;
    while (retired.length) {
      const item = retired.pop()!;
      destroyChain(item.pipes);
      try {
        item.input?.destroy();
      } catch {
        /* ignore */
      }
    }
  };

  /** Size the canvas to the picture's on-screen size (contain-fit, device pixels) and build the chain. */
  const setup = (): boolean => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return false;
    // New shaders compile on their first frames: judge the chain only after it settles.
    graceUntil = performance.now() + 2500;
    w = Math.min(vw, maxDim);
    h = Math.min(vh, maxDim);
    const target = computeTargetSize(canvas, w, h, maxDim);
    canvas.width = target.width;
    canvas.height = target.height;
    const oldPipes = pipes;
    const oldInput = input;
    pipes = [];
    input = device.createTexture({
      size: [w, h, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const built = buildChain(A, device, input, mode as Exclude<EnhanceMode, "off">, { width: w, height: h }, target);
    if (!built.pipes.length) {
      releaseResources(oldPipes, oldInput);
      return false;
    }
    pipes = built.pipes;
    chain = built.chain;
    releaseResources(oldPipes, oldInput);
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
        { binding: 1, resource: out.createView() },
      ],
    });
    return true;
  };

  if (!setup()) {
    qset?.destroy();
    qbuf?.destroy();
    rbuf?.destroy();
    try {
      ctx.unconfigure();
    } catch {
      /* ignore */
    }
    throw new Error("Video frame dimensions unavailable");
  }

  // A stream served without CORS can't be read by the GPU; say so instead of drawing black.
  try {
    device.queue.copyExternalImageToTexture({ source: video }, { texture: input! }, [w, h]);
  } catch (err) {
    destroyChain(pipes);
    pipes = [];
    input?.destroy();
    qset?.destroy();
    qbuf?.destroy();
    rbuf?.destroy();
    try {
      ctx.unconfigure();
    } catch {
      /* ignore */
    }
    throw new Error(
      isSecurityOrCorsError(err)
        ? "Cross-origin stream doesn't allow GPU frame access (CORS)"
        : "This stream doesn't allow picture processing",
    );
  }

  let running = true;
  let frameToken: { id: number; rvfc: boolean } | null = null;
  /** Frames submitted but not yet finished. Two may overlap: the GPU runs them in order, and
   *  waiting for each to be confirmed before starting the next wastes a whole IPC round trip. */
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
  let consecutiveErrors = 0;

  const triggerFallback = (why: string) => {
    if (!running) return;
    stop();
    opts.onFallback?.(why);
  };

  const process = () => {
    if (!running || !input || !bind) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (video.readyState < 2 || !vw || !vh) return;
    // Sync immediately when stream resolution changes mid-playback (e.g., HLS/DASH ABR switch).
    if (vw !== w || vh !== h) {
      if (!setup()) return;
    }
    try {
      device.queue.copyExternalImageToTexture({ source: video }, { texture: input! }, [w, h]);
      consecutiveErrors = 0;
    } catch (err) {
      if (isSecurityOrCorsError(err)) {
        triggerFallback("Cross-origin stream blocked GPU access — playing native video");
        return;
      }
      if (++consecutiveErrors >= 8 && !video.seeking && !video.paused) {
        triggerFallback("Video frame capture failed — switched to native video");
      }
      return; // a transient frame that can't be read (mid-seek) is skipped
    }

    let enc: GPUCommandEncoder;
    try {
      enc = device.createCommandEncoder();
      const stamp = !!(qset && rbuf && !reading);
      if (stamp) enc.beginComputePass({ timestampWrites: { querySet: qset!, beginningOfPassWriteIndex: 0 } }).end();
      for (const p of pipes) p.pass(enc);
      if (stamp) {
        enc.beginComputePass({ timestampWrites: { querySet: qset!, endOfPassWriteIndex: 1 } }).end();
        enc.resolveQuerySet(qset!, 0, 2, qbuf!, 0);
        enc.copyBufferToBuffer(qbuf!, 0, rbuf!, 0, 16);
      }
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: ctx.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(render);
      pass.setBindGroup(0, bind!);
      pass.draw(3);
      pass.end();
      const t0 = performance.now();
      if (stamp) reading = true;
      inflight++;
      processed++;
      device.queue.submit([enc.finish()]);
      device.queue
        .onSubmittedWorkDone()
        .then(async () => {
          inflight = Math.max(0, inflight - 1);
          flushRetired();
          let ms = performance.now() - t0; // fallback: includes GPU-process round trip, so it overstates
          if (stamp) {
            try {
              if (running && rbuf) {
                await rbuf.mapAsync(GPUMapMode.READ);
                const t = new BigUint64Array(rbuf.getMappedRange().slice(0));
                rbuf.unmap();
                if (t[1] > t[0]) ms = Number(t[1] - t[0]) / 1e6;
              }
            } catch {
              try {
                rbuf?.unmap();
              } catch {
                /* ignore */
              }
            } finally {
              reading = false;
              if (!running && rbuf) {
                try {
                  rbuf.destroy();
                } catch {
                  /* ignore */
                }
                rbuf = null;
              }
            }
          }
          if (!running) return;
          gpuEma = gpuEma ? gpuEma * 0.85 + ms * 0.15 : ms;
          govern();
        })
        .catch(() => {
          inflight = Math.max(0, inflight - 1);
          flushRetired();
          if (stamp) {
            reading = false;
            if (!running && rbuf) {
              try {
                rbuf.destroy();
              } catch {
                /* ignore */
              }
              rbuf = null;
            }
          }
        });
    } catch {
      reading = false;
      triggerFallback("GPU render pass failed — switched to native video");
    }
  };

  /**
   * Step down a tier when the chain can't keep up for about two seconds: GPU time above ~95% of
   * the video's frame interval (when it can be measured), or more than a third of frames
   * skipped because the GPU was still busy.
   */
  const govern = () => {
    if (!running) return;
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
      stop();
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
    } else {
      process();
    }
    if (running) {
      frameToken = scheduleFrame(video, frame);
    }
  };

  // Monitor WebGPU device loss and uncaptured shader/validation errors for automatic fallback.
  device.lost
    .then((info) => {
      if (!running) return;
      triggerFallback(info?.message ? `GPU context lost (${info.message})` : "GPU context lost — switched to native video");
    })
    .catch(() => {});

  const onUncapturedError = (ev: Event) => {
    if (!running) return;
    const msg = (ev as GPUUncapturedErrorEvent)?.error?.message;
    triggerFallback(msg ? `GPU error: ${msg}` : "GPU shader error — switched to native video");
  };
  device.addEventListener?.("uncapturederror", onUncapturedError);

  // Paint the current frame right away (covers a paused video), then follow new frames.
  process();
  if (running) {
    frameToken = scheduleFrame(video, frame);
  }

  // Fullscreen / window resize: rebuild for the new on-screen size (debounced).
  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (!running) return;
      if (setup() && inflight < MAX_INFLIGHT) process();
    }, 250);
  });
  if (canvas.parentElement) ro.observe(canvas.parentElement);

  // Stream intrinsic resolution change (e.g. HLS/DASH adaptive quality switch): rebuild immediately.
  const onVideoResize = () => {
    if (!running) return;
    if (setup() && inflight < MAX_INFLIGHT) process();
  };
  // Seeking while paused produces no new video frame callback on some sources: repaint.
  const onSeeked = () => {
    if (running && inflight < MAX_INFLIGHT) process();
  };

  video.addEventListener("resize", onVideoResize);
  video.addEventListener("seeked", onSeeked);

  const stop = () => {
    if (!running) return;
    running = false;
    cancelFrame(video, frameToken);
    frameToken = null;
    video.removeEventListener("resize", onVideoResize);
    video.removeEventListener("seeked", onSeeked);
    device?.removeEventListener?.("uncapturederror", onUncapturedError);
    ro.disconnect();
    clearTimeout(resizeTimer);
    releaseResources(pipes, input);
    pipes = [];
    input = null;
    flushRetired();
    try {
      qset?.destroy();
      qbuf?.destroy();
      if (!reading && rbuf) {
        rbuf.destroy();
        rbuf = null;
      }
    } catch {
      /* ignore */
    }
    try {
      ctx.unconfigure();
    } catch {
      /* already gone */
    }
    canvas.width = 0;
    canvas.height = 0;
  };

  return {
    stop,
    stats: () => ({
      mode,
      gpuMs: Math.round(gpuEma * 10) / 10,
      skipped,
      chain,
      backend: "webgpu",
    }),
  };
}

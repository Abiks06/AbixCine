import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startEnhancer } from "./enhance";

const createdPipeOutputs: { destroy: ReturnType<typeof vi.fn> }[] = [];

vi.mock("anime4k-webgpu", () => {
  class FakePipe {
    out: { width: number; height: number; createView: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    constructor() {
      this.out = {
        width: 1280,
        height: 720,
        createView: vi.fn(() => ({})),
        destroy: vi.fn(),
      };
      createdPipeOutputs.push(this.out);
    }
    pass = vi.fn();
    getOutputTexture() {
      return this.out;
    }
  }
  return {
    DoG: FakePipe,
    ClampHighlights: FakePipe,
    CNNVL: FakePipe,
    CNNx2VL: FakePipe,
    CNNx2M: FakePipe,
    CNNM: FakePipe,
    CNNSoftM: FakePipe,
  };
});

class FakeEventTarget {
  private listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, fn: EventListener, opts?: AddEventListenerOptions | boolean) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    if (typeof opts === "object" && opts?.once) {
      const wrapped: EventListener = (e) => {
        this.removeEventListener(type, wrapped);
        fn(e);
      };
      this.listeners.get(type)!.add(wrapped);
    } else {
      this.listeners.get(type)!.add(fn);
    }
  }

  removeEventListener(type: string, fn: EventListener) {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(ev: { type: string; [k: string]: unknown }) {
    const set = this.listeners.get(ev.type);
    if (!set) return true;
    for (const fn of [...set]) fn(ev as unknown as Event);
    return true;
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function makeFakeVideo(opts: { readyState?: number; width?: number; height?: number } = {}) {
  const target = new FakeEventTarget();
  let nextRvfcId = 1;
  const rvfcCallbacks = new Map<number, VideoFrameRequestCallback>();
  const video = {
    readyState: opts.readyState ?? 4,
    videoWidth: opts.width ?? 1280,
    videoHeight: opts.height ?? 720,
    currentTime: 10,
    playbackRate: 1,
    paused: false,
    seeking: false,
    crossOrigin: null as string | null,
    src: "",
    currentSrc: "",
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    listenerCount: target.listenerCount.bind(target),
    requestVideoFrameCallback: vi.fn((cb: VideoFrameRequestCallback) => {
      const id = nextRvfcId++;
      rvfcCallbacks.set(id, cb);
      return id;
    }),
    cancelVideoFrameCallback: vi.fn((id: number) => {
      rvfcCallbacks.delete(id);
    }),
    stepFrame(mediaTime = 10.04) {
      const entries = [...rvfcCallbacks.entries()];
      rvfcCallbacks.clear();
      for (const [, cb] of entries) {
        cb(performance.now(), {
          mediaTime,
          presentedFrames: 1,
          expectedDisplayTime: performance.now() + 16,
          width: video.videoWidth,
          height: video.videoHeight,
          presentationTime: performance.now(),
        });
      }
    },
    activeCallbackCount: () => rvfcCallbacks.size,
  };
  return video as unknown as HTMLVideoElement & {
    listenerCount(type: string): number;
    stepFrame(mediaTime?: number): void;
    activeCallbackCount(): number;
    dispatchEvent(ev: { type: string; [k: string]: unknown }): boolean;
  };
}

function makeWebGL2Canvas(opts: { throwSecurityOnUpload?: boolean } = {}) {
  const target = new FakeEventTarget();
  let contextLost = false;
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    TEXTURE_2D: 0x0de1,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    CLAMP_TO_EDGE: 0x812f,
    LINEAR: 0x2601,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE0: 0x84c0,
    TRIANGLES: 0x0004,
    MAX_TEXTURE_SIZE: 0x0d33,
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ""),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ""),
    deleteProgram: vi.fn(),
    createVertexArray: vi.fn(() => ({})),
    deleteVertexArray: vi.fn(),
    createTexture: vi.fn(() => ({})),
    deleteTexture: vi.fn(),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    getUniformLocation: vi.fn(() => ({})),
    getParameter: vi.fn(() => 4096),
    viewport: vi.fn(),
    texImage2D: vi.fn(() => {
      if (opts.throwSecurityOnUpload) {
        const err = new Error("Tainted canvas may not be loaded");
        err.name = "SecurityError";
        throw err;
      }
    }),
    isContextLost: vi.fn(() => contextLost),
    useProgram: vi.fn(),
    bindVertexArray: vi.fn(),
    activeTexture: vi.fn(),
    uniform1i: vi.fn(),
    uniform2f: vi.fn(),
    uniform1f: vi.fn(),
    drawArrays: vi.fn(),
  };

  const parent = {
    getBoundingClientRect: () => ({ width: 1920, height: 1080 }),
  };

  const canvas = {
    width: 0,
    height: 0,
    parentElement: parent,
    getContext: vi.fn((kind: string) => (kind === "webgl2" ? gl : null)),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    loseContext() {
      contextLost = true;
      target.dispatchEvent({ type: "webglcontextlost", preventDefault: vi.fn() });
    },
    gl,
  };
  return canvas as unknown as HTMLCanvasElement & {
    loseContext(): void;
    gl: typeof gl;
  };
}

beforeEach(() => {
  vi.stubGlobal("window", {
    devicePixelRatio: 1,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestAnimationFrame: (cb: FrameRequestCallback) => globalThis.setTimeout(() => cb(performance.now()), 16) as unknown as number,
    cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id),
  });
  vi.stubGlobal("document", {
    hidden: false,
    createElement: (tag: string) => (tag === "canvas" ? makeWebGL2Canvas() : {}),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("navigator", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("video upscaler lifecycle & hardware fallback", () => {
  it("aborts cleanly during video readiness wait without leaving orphaned listeners", async () => {
    const video = makeFakeVideo({ readyState: 0, width: 0, height: 0 });
    const canvas = makeWebGL2Canvas();
    const ac = new AbortController();

    const promise = startEnhancer(video, canvas, "a", { signal: ac.signal });
    expect(video.listenerCount("loadeddata")).toBe(1);
    expect(video.listenerCount("resize")).toBe(1);

    ac.abort();
    await expect(promise).rejects.toThrow(/Aborted/);
    expect(video.listenerCount("loadeddata")).toBe(0);
    expect(video.listenerCount("resize")).toBe(0);
    expect(video.activeCallbackCount()).toBe(0);
  });

  it("syncs canvas and shader uniforms when adaptive stream resolution changes mid-playback", async () => {
    const video = makeFakeVideo({ readyState: 4, width: 854, height: 480 });
    const canvas = makeWebGL2Canvas();

    const enh = await startEnhancer(video, canvas, "a");
    expect(video.crossOrigin).toBe("anonymous");
    expect(enh.stats().backend).toBe("webgl2");
    expect(canvas.gl.uniform2f).toHaveBeenLastCalledWith(expect.anything(), 1 / 854, 1 / 480);

    // Simulate HLS adaptive level switch from 480p to 1080p
    Object.assign(video, { videoWidth: 1920, videoHeight: 1080 });
    video.dispatchEvent({ type: "resize" });
    expect(canvas.gl.uniform2f).toHaveBeenLastCalledWith(expect.anything(), 1 / 1920, 1 / 1080);

    enh.stop();
    expect(video.activeCallbackCount()).toBe(0);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("rejects immediately on CORS-tainted video frames so native video stays visible", async () => {
    const video = makeFakeVideo({ readyState: 4, width: 1280, height: 720 });
    const canvas = makeWebGL2Canvas({ throwSecurityOnUpload: true });

    await expect(startEnhancer(video, canvas, "clarity")).rejects.toThrow(/CORS/i);
  });

  it("detects runtime WebGL context loss, tears down the shader canvas, and invokes onFallback", async () => {
    const video = makeFakeVideo({ readyState: 4, width: 1280, height: 720 });
    const canvas = makeWebGL2Canvas();
    const onFallback = vi.fn();

    const enh = await startEnhancer(video, canvas, "a", { onFallback });
    expect(video.activeCallbackCount()).toBe(1);

    canvas.loseContext();
    expect(onFallback).toHaveBeenCalledWith(expect.stringMatching(/context lost/i));
    expect(video.activeCallbackCount()).toBe(0);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);

    enh.stop();
  });

  it("prevents overlapping timestamp query buffer writes under MAX_INFLIGHT=2 and destroys pipeline textures on rebuild/stop", async () => {
    createdPipeOutputs.length = 0;
    vi.stubGlobal("GPUBufferUsage", { QUERY_RESOLVE: 512, COPY_SRC: 4, COPY_DST: 8, MAP_READ: 1 });
    vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 });
    vi.stubGlobal("GPUMapMode", { READ: 1 });

    let resolveWork1!: () => void;
    let resolveWork2!: () => void;
    let resolveLost!: (v: unknown) => void;
    const workPromises = [
      new Promise<void>((r) => {
        resolveWork1 = r;
      }),
      new Promise<void>((r) => {
        resolveWork2 = r;
      }),
    ];
    let submitCount = 0;

    const rbuf = {
      destroy: vi.fn(),
      mapAsync: vi.fn(async () => {}),
      getMappedRange: vi.fn(() => {
        const arr = new BigUint64Array([1_000_000n, 5_000_000n]);
        return arr.buffer;
      }),
      unmap: vi.fn(),
    };
    const qbuf = { destroy: vi.fn() };
    const qset = { destroy: vi.fn() };
    const createdTextures: { destroy: ReturnType<typeof vi.fn> }[] = [];
    const copyBufferCalls: unknown[][] = [];

    const fakeDevice = {
      limits: { maxTextureDimension2D: 4096 },
      features: new Set(["timestamp-query"]),
      lost: new Promise((r) => {
        resolveLost = r;
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      createShaderModule: vi.fn(() => ({})),
      createSampler: vi.fn(() => ({})),
      createRenderPipeline: vi.fn(() => ({
        getBindGroupLayout: vi.fn(() => ({})),
      })),
      createQuerySet: vi.fn(() => qset),
      createBuffer: vi.fn((desc: { usage: number }) => (desc.usage & 1 ? rbuf : qbuf)),
      createTexture: vi.fn(() => {
        const t = { destroy: vi.fn(), createView: vi.fn(() => ({})) };
        createdTextures.push(t);
        return t;
      }),
      createBindGroup: vi.fn(() => ({})),
      createCommandEncoder: vi.fn(() => ({
        beginComputePass: vi.fn(() => ({ end: vi.fn() })),
        resolveQuerySet: vi.fn(),
        copyBufferToBuffer: vi.fn((...args: unknown[]) => copyBufferCalls.push(args)),
        beginRenderPass: vi.fn(() => ({
          setPipeline: vi.fn(),
          setBindGroup: vi.fn(),
          draw: vi.fn(),
          end: vi.fn(),
        })),
        finish: vi.fn(() => ({})),
      })),
      queue: {
        copyExternalImageToTexture: vi.fn(),
        submit: vi.fn(),
        onSubmittedWorkDone: vi.fn(() => workPromises[submitCount++] ?? Promise.resolve()),
      },
    };

    vi.stubGlobal("navigator", {
      gpu: {
        getPreferredCanvasFormat: () => "bgra8unorm",
        requestAdapter: vi.fn(async () => ({
          features: new Set(["timestamp-query"]),
          requestDevice: vi.fn(async () => fakeDevice),
        })),
      },
    });

    const video = makeFakeVideo({ readyState: 4, width: 1280, height: 720 });
    const webgpuCtx = {
      configure: vi.fn(),
      unconfigure: vi.fn(),
      getCurrentTexture: vi.fn(() => ({ createView: vi.fn(() => ({})) })),
    };
    const canvas = {
      width: 0,
      height: 0,
      parentElement: { getBoundingClientRect: () => ({ width: 1920, height: 1080 }) },
      getContext: vi.fn((kind: string) => (kind === "webgpu" ? webgpuCtx : null)),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLCanvasElement;

    const enh = await startEnhancer(video, canvas, "a");
    // Frame 1 was submitted on startup; its onSubmittedWorkDone has NOT resolved yet.
    expect(copyBufferCalls.length).toBe(1);

    // Trigger Frame 2 while Frame 1 is still in flight on the GPU queue (inflight = 1 < MAX_INFLIGHT = 2).
    video.stepFrame(10.04);
    // Frame 2 must NOT write to qbuf/rbuf while Frame 1's timestamp query readback is pending.
    expect(copyBufferCalls.length).toBe(1);

    // Trigger an ABR resolution change while Frame 1 and Frame 2 are STILL in flight (inflight === 2);
    // old input texture and pipeline output textures must be retired and destroyed only after in-flight work finishes.
    const firstInputTex = createdTextures[0];
    const firstPipeOut = createdPipeOutputs[0];
    Object.assign(video, { videoWidth: 1920, videoHeight: 1080 });
    video.dispatchEvent({ type: "resize" });
    expect(firstInputTex.destroy).not.toHaveBeenCalled();
    expect(firstPipeOut.destroy).not.toHaveBeenCalled();

    // Resolve Frame 1 and Frame 2 GPU work; retired textures are now flushed and destroyed.
    resolveWork1();
    resolveWork2();
    await new Promise((r) => setTimeout(r, 10));
    expect(rbuf.mapAsync).toHaveBeenCalledTimes(1);
    expect(firstInputTex.destroy).toHaveBeenCalled();
    expect(firstPipeOut.destroy).toHaveBeenCalled();

    enh.stop();
    expect(qset.destroy).toHaveBeenCalled();
    expect(qbuf.destroy).toHaveBeenCalled();
    resolveLost({});
  });

  it("cleans up shaders and rejects gracefully if WebGL2 createProgram or createTexture returns null", async () => {
    const video = makeFakeVideo({ readyState: 4, width: 1280, height: 720 });
    const canvas = makeWebGL2Canvas();
    canvas.gl.createProgram = vi.fn(() => null as unknown as WebGLProgram);

    await expect(startEnhancer(video, canvas, "a")).rejects.toThrow(/Failed to allocate WebGL2 program/i);
    expect(canvas.gl.deleteShader).toHaveBeenCalledTimes(2);

    const canvas2 = makeWebGL2Canvas();
    canvas2.gl.createTexture = vi.fn(() => null as unknown as WebGLTexture);
    await expect(startEnhancer(video, canvas2, "a")).rejects.toThrow(/Failed to allocate WebGL2 resources/i);
    expect(canvas2.gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(canvas2.gl.deleteProgram).toHaveBeenCalledTimes(1);
  });
});

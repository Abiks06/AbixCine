import type JASSUB from "jassub";
import { memo, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { CueAlign, CueSpan, SubPref, SubtitleCue } from "../lib/subtitles";
import type { SubtitleFormat } from "../sources/types";

export interface SubtitleOverlayProps {
  cues: readonly SubtitleCue[];
  secondaryCues?: readonly SubtitleCue[];
  subPref: SubPref;
  controlsVisible: boolean;
  /** Render scaled for the Settings live preview stage instead of fullscreen player viewport units. */
  preview?: boolean;
  className?: string;
  /** Video element to attach JASSUB canvas to for native ASS/SSA rendering. */
  videoRef?: RefObject<HTMLVideoElement | null>;
  /** Raw ASS/SSA script text for the active primary track (when format is ass/ssa). */
  assRaw?: string;
  /** Format of the active primary track. */
  assFormat?: SubtitleFormat;
  /** Subtitle timing offset in seconds (positive delays subtitles, matching activeCuesAt). */
  offsetSec?: number;
  /** Whether primary subtitle rendering is enabled (false hides JASSUB even if raw text is cached). */
  subEnabled?: boolean;
}

const HEX_OR_RGB_RX = /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/i;

function safeCssColor(color: string | undefined, fallback?: string): string | undefined {
  if (!color) return fallback;
  const trimmed = color.trim();
  return HEX_OR_RGB_RX.test(trimmed) ? trimmed : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function posAnchorTransform(align: CueAlign): string {
  const x = align === 1 || align === 4 || align === 7 ? "0%" : align === 3 || align === 6 || align === 9 ? "-100%" : "-50%";
  const y = align >= 7 ? "0%" : align >= 4 ? "-50%" : "-100%";
  return `translate(${x}, ${y})`;
}

function textAlignFor(align: CueAlign): CSSProperties["textAlign"] {
  if (align === 1 || align === 4 || align === 7) return "left";
  if (align === 3 || align === 6 || align === 9) return "right";
  return "center";
}

function CueSpans({ cue }: { cue: SubtitleCue }) {
  if (!cue.spans?.length) return <>{cue.text}</>;
  return (
    <>
      {cue.spans.map((span: CueSpan, idx: number) => {
        const decos = [span.underline ? "underline" : null, span.strike ? "line-through" : null].filter(Boolean);
        const spanColor = safeCssColor(span.color);
        const style: CSSProperties | undefined =
          span.bold || span.italic || decos.length || spanColor
            ? {
                ...(span.bold ? { fontWeight: 700 } : {}),
                ...(span.italic ? { fontStyle: "italic" } : {}),
                ...(decos.length ? { textDecorationLine: decos.join(" ") } : {}),
                ...(spanColor ? { color: spanColor } : {}),
              }
            : undefined;
        return (
          <span key={idx} style={style}>
            {span.text}
          </span>
        );
      })}
    </>
  );
}

const ALL_ZONES: readonly CueAlign[] = [7, 8, 9, 4, 5, 6, 1, 2, 3];

export const SubtitleOverlay = memo(function SubtitleOverlay({
  cues,
  secondaryCues,
  subPref,
  controlsVisible,
  preview = false,
  className = "",
  videoRef,
  assRaw,
  assFormat,
  offsetSec = 0,
  subEnabled = true,
}: SubtitleOverlayProps) {
  const isAssTrack = !preview && subEnabled && (assFormat === "ass" || assFormat === "ssa") && Boolean(assRaw);
  const jassubKey = isAssTrack && assRaw ? `${assFormat}:${assRaw.length}:${assRaw.slice(0, 64)}` : "";

  const jassubRef = useRef<JASSUB | null>(null);
  const offsetRef = useRef(offsetSec);
  offsetRef.current = offsetSec;

  const [jassubState, setJassubState] = useState<{ key: string; failed: boolean }>({ key: "", failed: false });
  const jassubFailed = jassubState.key === jassubKey && jassubState.failed;
  const usingJassub = isAssTrack && !jassubFailed && Boolean(videoRef?.current);

  useEffect(() => {
    const videoEl = videoRef?.current;
    if (!isAssTrack || !assRaw || !videoEl) {
      const prev = jassubRef.current;
      jassubRef.current = null;
      if (prev) void prev.destroy().catch(() => {});
      return;
    }

    let cancelled = false;
    let instance: JASSUB | null = null;

    (async () => {
      try {
        const [
          { default: JassubCtor },
          { default: workerUrl },
          { default: wasmUrl },
          { default: modernWasmUrl },
          { default: wasmWorkerUrl },
          { default: modernWasmWorkerUrl },
          { default: defaultFontUrl },
        ] = await Promise.all([
          import("jassub"),
          import("jassub/dist/worker/worker.js?worker&url"),
          import("jassub/dist/wasm/jassub-worker.wasm?url"),
          import("jassub/dist/wasm/jassub-worker-modern.wasm?url"),
          import("jassub/dist/wasm/jassub-worker.js?url"),
          import("jassub/dist/wasm/jassub-worker-modern.js?url"),
          import("jassub/dist/default.woff2?url"),
        ]);

        if (cancelled || !videoEl.isConnected) return;

        instance = new JassubCtor({
          video: videoEl,
          subContent: assRaw,
          timeOffset: Number.isFinite(offsetRef.current) ? -offsetRef.current : 0,
          workerUrl,
          wasmUrl,
          modernWasmUrl,
          wasmWorkerUrl,
          modernWasmWorkerUrl,
          availableFonts: { "liberation sans": defaultFontUrl },
          defaultFont: "liberation sans",
        });
        jassubRef.current = instance;

        await instance.ready;
        if (cancelled) {
          if (jassubRef.current === instance) jassubRef.current = null;
          void instance.destroy().catch(() => {});
          return;
        }
        void instance.resize(true).catch(() => {});
      } catch {
        if (instance) {
          if (jassubRef.current === instance) jassubRef.current = null;
          void instance.destroy().catch(() => {});
        }
        if (!cancelled) {
          setJassubState({ key: jassubKey, failed: true });
        }
      }
    })();

    return () => {
      cancelled = true;
      const active = jassubRef.current ?? instance;
      jassubRef.current = null;
      if (active) void active.destroy().catch(() => {});
    };
  }, [isAssTrack, assRaw, jassubKey, videoRef]);

  useEffect(() => {
    const inst = jassubRef.current;
    if (!inst) return;
    inst.timeOffset = Number.isFinite(offsetSec) ? -offsetSec : 0;
    void inst.ready.then(() => inst.resize(true)).catch(() => {});
  }, [offsetSec]);

  const primaryCues = usingJassub ? [] : cues;
  const secList = secondaryCues ?? [];
  if (!primaryCues.length && !secList.length) return null;

  const zoneMap = new Map<CueAlign, SubtitleCue[]>();
  const positioned: SubtitleCue[] = [];

  for (const cue of primaryCues) {
    if (cue.pos) {
      positioned.push(cue);
    } else {
      const z = (cue.align >= 1 && cue.align <= 9 ? cue.align : 2) as CueAlign;
      const bucket = zoneMap.get(z);
      if (bucket) bucket.push(cue);
      else zoneMap.set(z, [cue]);
    }
  }

  // Secondary subtitles render in a distinct top-center band by default so they never collide
  // with standard bottom-center dialogue. If primary already uses top-center without bottom-center,
  // park secondary at bottom-center; if both top and bottom are occupied, offset below top-center.
  const hasTopCenter = zoneMap.has(8);
  const hasBottomCenter = zoneMap.has(2);
  const secondaryPosClass = hasTopCenter && !hasBottomCenter
    ? "at-bottom"
    : hasTopCenter && hasBottomCenter
      ? "at-top below-top"
      : "at-top";

  const rootStyle = {
    "--sub-color": safeCssColor(subPref.color, "#ffffff"),
    "--sub-bg-opacity": String(clamp(subPref.bgOpacity ?? 0.72, 0, 1)),
    "--sub-bottom": String(clamp(subPref.bottomPct ?? 7, 2, 45)),
    "--sub-line-height": String(clamp(subPref.lineHeight ?? 1.35, 1, 2.2)),
  } as CSSProperties;

  const rootClass = [
    "sub-overlay",
    `sub-size-${subPref.size || "m"}`,
    `sub-font-${subPref.font || "sans"}`,
    `sub-bg-${subPref.bg || "glass"}`,
    `sub-edge-${subPref.edge || "shadow"}`,
    controlsVisible && !preview ? "controls-up" : "",
    preview ? "is-preview" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rootClass} style={rootStyle} aria-live="polite">
      {ALL_ZONES.map((zone) => {
        const list = zoneMap.get(zone);
        if (!list?.length) return null;
        return (
          <div key={zone} className={`sub-zone sub-zone-${zone}`}>
            {list.map((cue) => (
              <div key={cue.id} className="sub-cue">
                <CueSpans cue={cue} />
              </div>
            ))}
          </div>
        );
      })}

      {positioned.map((cue) => {
        const x = clamp(cue.pos!.xPct, 2, 98);
        const y = clamp(cue.pos!.yPct, 2, 98);
        const align = (cue.align >= 1 && cue.align <= 9 ? cue.align : 2) as CueAlign;
        return (
          <div
            key={cue.id}
            className="sub-pos-cue"
            style={{
              left: `${x}%`,
              top: `${y}%`,
              transform: posAnchorTransform(align),
              textAlign: textAlignFor(align),
              zIndex: cue.layer != null ? Math.max(1, Math.min(50, cue.layer)) : undefined,
            }}
          >
            <div className="sub-cue">
              <CueSpans cue={cue} />
            </div>
          </div>
        );
      })}

      {secList.length > 0 && (
        <div className={`sub-zone sub-dual-zone ${secondaryPosClass}`}>
          {secList.map((cue) => (
            <div key={`sec-${cue.id}`} className="sub-cue is-secondary">
              <CueSpans cue={cue} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

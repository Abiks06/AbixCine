import { memo, type CSSProperties } from "react";
import type { CueAlign, CueSpan, SubPref, SubtitleCue } from "../lib/subtitles";

export interface SubtitleOverlayProps {
  cues: readonly SubtitleCue[];
  secondaryCues?: readonly SubtitleCue[];
  subPref: SubPref;
  controlsVisible: boolean;
  /** Render scaled for the Settings live preview stage instead of fullscreen player viewport units. */
  preview?: boolean;
  className?: string;
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
}: SubtitleOverlayProps) {
  const secList = secondaryCues ?? [];
  if (!cues.length && !secList.length) return null;

  const zoneMap = new Map<CueAlign, SubtitleCue[]>();
  const positioned: SubtitleCue[] = [];

  for (const cue of cues) {
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

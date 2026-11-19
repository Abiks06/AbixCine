import type { KeyboardEvent } from "react";
import { fmtRuntime } from "../sources/identity";
import { candKey, candLine } from "../sources/registry";
import type { Lane, SessionSnapshot } from "../sources/session";
import type { StreamCandidate } from "../sources/types";
import { Icon } from "./Icon";

/**
 * The one server list. The title page, the loading screen and the player all render a source
 * session through this, so a server looks and behaves the same wherever you meet it.
 */

export type RowState = "playing" | "ready" | "checking" | "waiting" | "failed" | "searching";

export interface BoardRow {
  id: string;
  name: string;
  state: RowState;
  /** Missing for a provider that is still searching or never answered. */
  c?: StreamCandidate;
  note: string;
  /** Plays, but probably isn't this title (far off the catalog runtime). Never picked automatically. */
  suspect?: boolean;
}

const fmtMs = (ms?: number) => (ms == null || ms <= 0 ? null : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

/** How this stream reaches the screen, in two words or fewer. */
export function viaLabel(c: StreamCandidate) {
  if (c.providerId === "local") return "This PC";
  if (c.providerId === "jellyfin") return "Jellyfin";
  if (c.providerId === "manual") return "Link";
  if (/^magnet:/i.test(c.url)) return "Torrent";
  if (c.kind === "embed") return c.probe?.ok ? "Web player" : "Online";
  return c.via === "sniffed" ? "Ad-free" : "Direct";
}

export const qualityLabel = (c: StreamCandidate) => {
  const q = c.probe?.quality ?? c.quality;
  return q ? (q >= 2160 ? "4K" : `${q}p`) : null;
};

export const audioLabel = (c: StreamCandidate) =>
  c.audio === "dub" ? "DUB" : c.audio === "sub" ? "SUB" : c.audio === "dual" ? "DUAL" : c.audio === "unknown" ? "JP?" : null;

/** Plays, but its length is far off the catalog runtime: probably another title, or a trailer. */
export const isSuspect = (c: StreamCandidate) => !!c.probe?.ok && c.identity?.status === "mismatch";

/** What a search-based server found: “The Odyssey” (2026). */
export const foundLabel = (c: StreamCandidate) =>
  c.matched?.title ? `“${c.matched.title}”${c.matched.year ? ` (${c.matched.year})` : ""}` : null;

/** "Might be a different title · runs 1 h 32 min, should be 2 h 30 min". */
export function suspectNote(c: StreamCandidate) {
  const id = c.identity;
  const runs = fmtRuntime(id?.durationSec);
  const should = fmtRuntime(id?.expectedSec);
  const detail = runs && should ? `runs ${runs}, should be ${should}` : id?.off === "short" ? "much too short" : "much too long";
  return `Might be a different title · ${detail}`;
}

/** Why a provider that returned nothing is listed as unavailable, in words. */
function laneNote(lane: Lane) {
  if (lane.status === "timeout") return "Didn't answer in time";
  const e = lane.error ?? "";
  if (/circuit open|cooling down/i.test(e)) return "Resting after recent errors";
  if (/enc-dec\.app unavailable/i.test(e)) return "Its decoding service is down";
  if (/\b(?:401|403)\b/.test(e)) return "Refused the request";
  if (/\btime(?:d)? ?out\b/i.test(e)) return "Didn't answer in time";
  return "Couldn't be reached";
}

/** 0-3 bars from how quickly the stream answered. An unmeasured stream gets two, not a full house it didn't earn. */
const bars = (c: StreamCandidate) => {
  const ms = c.probe?.latencyMs;
  if (!c.probe?.ok) return 0;
  if (ms == null || ms <= 0) return 2;
  return ms < 1500 ? 3 : ms < 5000 ? 2 : 1;
};

export function boardRows(snap: SessionSnapshot, playingKey?: string): BoardRow[] {
  const rows: BoardRow[] = [];
  const listed = new Set<string>();
  // A provider with several streams (files in a folder, an addon's results) names each one.
  const perProvider = new Map<string, number>();
  for (const c of snap.candidates) perProvider.set(c.providerId, (perProvider.get(c.providerId) ?? 0) + 1);

  for (const c of snap.candidates) {
    const key = candKey(c);
    listed.add(c.providerId);
    const checking = snap.checking.has(key);
    const state: RowState = key === playingKey && c.probe?.ok ? "playing" : c.probe?.ok ? "ready" : checking ? "checking" : !c.probe ? "waiting" : "failed";
    const many = (perProvider.get(c.providerId) ?? 0) > 1 && c.label && c.label !== c.providerName;
    const suspect = isSuspect(c);
    const why = c.why?.filter((w) => w !== "might be a different title");
    let note =
      state === "playing"
        ? ["Playing now", fmtMs(c.probe?.latencyMs)].filter(Boolean).join(" · ")
        : state === "ready"
          ? suspect
            ? suspectNote(c)
            : snap.verifying?.has(key)
              ? "Checking it's the right title…"
              : why?.length
                ? why.slice(0, 2).join(" · ")
                : (fmtMs(c.probe?.latencyMs) ?? "ready")
          : state === "checking"
            ? c.kind === "embed"
              ? "Capturing the stream…"
              : "Checking…"
            : state === "waiting"
              ? "On standby"
              : candLine(c);
    // A server that found the title by searching its catalog by name says what it found.
    const found = foundLabel(c);
    if (found && suspect) note = `${note} · found ${found}`;
    else if (found && state !== "checking") note = `${found} · ${note}`;
    rows.push({ id: key, name: many ? c.label : c.providerName, state, c, note, ...(suspect ? { suspect } : {}) });
  }
  for (const lane of snap.lanes) {
    if (listed.has(lane.providerId)) continue;
    if (lane.status === "searching") rows.push({ id: `lane:${lane.providerId}`, name: lane.name, state: "searching", note: "Looking…" });
    else if (lane.status === "timeout" || lane.status === "error")
      rows.push({ id: `lane:${lane.providerId}`, name: lane.name, state: "failed", note: laneNote(lane) });
  }
  return rows;
}

const GROUPS: [RowState[], string][] = [
  [["playing", "ready"], "Ready"],
  [["checking", "searching"], "Checking"],
  [["waiting"], "On standby"],
  [["failed"], "Unavailable"],
];

interface Props {
  snap: SessionSnapshot;
  /** candKey of the stream on screen, in the player. */
  playingKey?: string;
  /** A row the parent is acting on (verifying before play, or connecting to). */
  busyKey?: string | null;
  /** What that row is doing. */
  busyNote?: string;
  onPick: (c: StreamCandidate) => void;
  /** Show at most this many rows, ready ones first. */
  limit?: number;
  /** Group headings (off for the compact title-page card). */
  grouped?: boolean;
  /** Rows the parent already derived from this snapshot, so they aren't built twice per render. */
  rows?: BoardRow[];
}

/** Arrow keys, Home and End move between the servers that can be picked. */
function moveFocus(e: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button.sb-row:not(:disabled)")];
  if (!rows.length) return;
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const last = rows.length - 1;
  const next =
    e.key === "Home" ? 0 : e.key === "End" ? last : e.key === "ArrowDown" ? (at < 0 ? 0 : Math.min(last, at + 1)) : at < 0 ? last : Math.max(0, at - 1);
  e.preventDefault();
  rows[next].focus();
}

export function SourceBoard({ snap, playingKey, busyKey, busyNote = "Checking…", onPick, limit, grouped = true, rows: given }: Props) {
  const all = given ?? boardRows(snap, playingKey);
  const pickKey = snap.pick ? candKey(snap.pick) : undefined;
  const order: RowState[] = ["playing", "ready", "checking", "searching", "waiting", "failed"];
  const sorted = [...all].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  const rows = limit ? sorted.slice(0, limit) : sorted;

  const row = (r: BoardRow, i: number) => {
    const c = r.c;
    const busy = r.state === "checking" || r.state === "searching" || (!!busyKey && busyKey === r.id);
    const q = c && (r.state === "ready" || r.state === "playing") ? qualityLabel(c) : null;
    const audio = c ? audioLabel(c) : null;
    const title =
      !c
        ? r.note
        : r.state === "playing"
          ? r.suspect
            ? `Playing now. ${r.note}`
            : "Playing now"
          : r.suspect
            ? `${r.note}. Probably another title or a trailer: play it anyway?`
            : r.state === "ready"
              ? `Play from ${r.name}`
              : r.state === "failed"
                ? `Try ${r.name} again`
                : `Check ${r.name} and play`;
    return (
      <button
        key={r.id}
        type="button"
        className={`sb-row ${r.state}${r.suspect ? " suspect" : ""} ${c && candKey(c) === pickKey ? "pick" : ""}`}
        disabled={!c || busy || r.state === "playing"}
        onClick={() => c && onPick(c)}
        style={{ ["--i" as string]: Math.min(i, 14) }}
        title={title}
      >
        <span className={`sb-sig b${c ? bars(c) : 0}`} aria-hidden><i /><i /><i /></span>
        <span className="sb-main">
          <span className="sb-name">
            <span className="sb-name-tx">{r.name}</span>
            {c && candKey(c) === pickKey && r.state !== "playing" && <em className="sb-auto">AUTO</em>}
          </span>
          <span className={`sb-note${r.suspect ? " warn" : ""}`}>{busyKey === r.id ? busyNote : r.note}</span>
        </span>
        <span className="sb-tags">
          {q && <b>{q}</b>}
          {audio && <b className={audio === "JP?" ? "warn" : ""} title={audio === "JP?" ? "This server can't switch audio" : undefined}>{audio}</b>}
          {r.suspect ? (
            <b className="warn">Other title?</b>
          ) : (
            c && (r.state === "ready" || r.state === "playing") && <b className="via">{viaLabel(c)}</b>
          )}
        </span>
        <span className="sb-act">
          {busy ? (
            <span className="mini-spin" />
          ) : r.state === "playing" ? (
            <span className="eq" aria-label="Playing"><i /><i /><i /><i /></span>
          ) : !c ? null : r.state === "failed" ? (
            <Icon name="refresh" size={13} />
          ) : (
            <Icon name="play" size={12} />
          )}
        </span>
      </button>
    );
  };

  if (!grouped) return <div className="sb" role="group" aria-label="Servers" onKeyDown={moveFocus}>{rows.map(row)}</div>;
  let n = 0;
  return (
    <div className="sb" role="group" aria-label="Servers" onKeyDown={moveFocus}>
      {GROUPS.map(([states, label]) => {
        const mine = rows.filter((r) => states.includes(r.state));
        if (!mine.length) return null;
        return (
          <div className="sb-group" key={label}>
            <div className="sb-h">{label}<span>{mine.length}</span></div>
            {mine.map((r) => row(r, n++))}
          </div>
        );
      })}
    </div>
  );
}

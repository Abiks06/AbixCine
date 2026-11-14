import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Player, type EpisodeNav } from "../components/Player";
import { Art } from "../components/Art";
import { Icon } from "../components/Icon";
import { Ambient } from "../components/Ambient";
import { qualityLabel, SourceBoard, viaLabel } from "../components/SourceBoard";
import { TitleArt } from "../components/TitleArt";
import {
  clampSeason,
  decodeKey,
  encodeKey,
  getDetail,
  getSeasonEpisodes,
  parseSeasonEpisodeParams,
  resolveNextEpisode,
  resolvePlaybackRequest,
} from "../lib/catalog";
import type { MediaDetail } from "../lib/types";
import { getEntry, getProgress, saveProgress } from "../lib/progress";
import { useWatchlist } from "../lib/watchlist";
import { audioFor, setAudioFor, useSettings, type Audio } from "../lib/settings";
import { animeEpisodes } from "../lib/anilist";
import { reqKey, type PlaybackRequest } from "../lib/types";
import { useAsync } from "../lib/useAsync";
import { isUrlTokenExpired } from "../sources/native";
import { candKey } from "../sources/registry";
import { useSourceSession } from "../sources/useSourceSession";
import type { StreamCandidate } from "../sources/types";

export function Watch() {
  const key = decodeKey(useParams().key ?? "");
  const [params] = useSearchParams();
  const nav = useNavigate();
  const loc = useLocation();
  /** Set when the player flipped sub/dub or moved episode: skip the race showcase. */
  const quick = !!(loc.state as { quick?: boolean } | null)?.quick;
  const settings = useSettings();
  const { season: rawSeason, episode: rawEpisode } = parseSeasonEpisodeParams(params);
  const rawAudio = params.get("a");
  const audioParam: Audio | undefined = rawAudio === "sub" || rawAudio === "dub" ? rawAudio : undefined;
  /** A server the viewer chose on the title page or the race screen (ignore if it's an expired stream URL). */
  const rawPreferred = params.get("srv") ?? undefined;
  const preferred = rawPreferred && !isUrlTokenExpired(rawPreferred) ? rawPreferred : undefined;
  const detail = useAsync(() => getDetail(key), [key]);
  // Offline / catalog down: local files and Jellyfin only need a title, so fall back to the copy
  // saved with progress or My List instead of spinning forever.
  const list = useWatchlist();
  const canonicalKey = detail.data?.canonicalKey ?? detail.data?.key ?? key;
  const courKeys = useMemo(
    () =>
      detail.data
        ? [...(detail.data.seasons ?? []), ...(detail.data.specials ?? [])].flatMap((s) => [
            s.key,
            ...(s.cours?.map((c) => c.key) ?? []),
          ])
        : [],
    [detail.data],
  );
  const savedEntry = getEntry(canonicalKey, [key, detail.data?.key, ...courKeys]);
  const d: MediaDetail | undefined = useMemo(() => {
    if (detail.data) return detail.data;
    if (!detail.error) return undefined;
    const m = savedEntry?.media ?? list.find((w) => w.media.key === key || w.media.key === canonicalKey)?.media;
    return m ? { ...m, cast: [], crew: [], related: [] } : undefined;
  }, [detail.data, detail.error, key, canonicalKey, list, savedEntry]);

  const isAnime = key.startsWith("anilist:") || d?.kind === "anime";
  const isSeries = key.startsWith("tmdb:tv:") || d?.kind === "tv";
  const isEpisodicAnime = isAnime && d?.kind !== "movie";
  const hasCanonicalSeasons = !!d?.seasons?.length || !!d?.specials?.length;
  const prelimSeason = rawSeason ?? (isSeries || hasCanonicalSeasons ? (savedEntry?.season ?? d?.initialSeason ?? 1) : undefined);
  const prelimEpisode = rawEpisode ?? (isSeries || isEpisodicAnime ? (savedEntry?.episode ?? 1) : undefined);
  const audio = audioParam ?? (isAnime ? audioFor(canonicalKey, [key, d?.key, ...courKeys]) : undefined);
  const requestedSeason = rawSeason ?? (rawEpisode == null ? savedEntry?.season : undefined);
  const resolvedReq = useMemo(
    () => (d ? resolvePlaybackRequest(d, requestedSeason, prelimEpisode, audio) : null),
    [d, requestedSeason, prelimEpisode, audio],
  );
  const season = resolvedReq ? resolvedReq.season : prelimSeason;
  const episode = resolvedReq ? resolvedReq.episode : prelimEpisode;
  const absolute = resolvedReq?.absolute;
  const req: PlaybackRequest | null = useMemo(
    () => resolvedReq ?? (d ? { media: d, season, episode, absolute, audio } : null),
    [resolvedReq, d, season, episode, absolute, audio],
  );

  /* ---------------------------------------------------------------- source */

  const { session, snap, recheck } = useSourceSession(req, 3);
  const reloadCatalog = useCallback(() => {
    if (detail.error) detail.reload();
    recheck();
  }, [detail, recheck]);
  const [manual, setManual] = useState("");
  /** The stream to start from: the session's pick, or a server chosen here or on the title page. */
  const [start, setStart] = useState<string | null>(null);
  /** A server being checked because the viewer asked to play from it. */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const live = useRef(session);
  live.current = session;
  useEffect(() => {
    setStart(null);
    setBusyKey(null);
    setNote(null);
  }, [session]);

  /** Play from a server the viewer picked: straight away if it's ready, after a check if not. */
  const playFrom = useCallback(
    async (c: StreamCandidate) => {
      if (!session) return;
      const k = candKey(c);
      session.choose(k);
      if (c.probe?.ok) return setStart(k);
      setBusyKey(k);
      setNote(null);
      const r = await session.verify(k);
      if (live.current !== session) return;
      setBusyKey(null);
      if (r?.probe?.ok) setStart(k);
      else setNote(r?.probe?.error && r.probe.error !== "no stream" ? `${c.providerName} couldn't play this (${r.probe.error}).` : `${c.providerName} doesn't have this one.`);
    },
    [session],
  );

  // A server chosen on the title page: go to it as soon as the session knows it.
  const prefFor = useRef<unknown>(null);
  const prefPending = !!preferred && prefFor.current !== session;
  useEffect(() => {
    if (!session || !snap || !preferred || prefFor.current === session) return;
    const c = session.find(preferred);
    if (!c && snap.busy) return;
    prefFor.current = session;
    if (c) void playFrom(c);
  }, [session, snap, preferred, playFrom]);

  // Hold the result on screen for a beat so you see which server won, then play.
  const pickKey = snap?.pick ? candKey(snap.pick) : undefined;
  useEffect(() => {
    if (!pickKey || start || busyKey || prefPending) return;
    const t = setTimeout(() => setStart(pickKey), settings.reduceMotion || quick ? 0 : 280);
    return () => clearTimeout(t);
  }, [pickKey, start, busyKey, prefPending]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = useMemo(() => resolveNextEpisode(d, season, episode, audio), [d, season, episode, audio]);

  // Carry the incoming navigation state (e.g. "opened from inside the app") forward, so Back
  // keeps working the same way after an in-player episode change or sub/dub switch.
  const forwardState = (extra: Record<string, unknown> = {}) => ({ ...(loc.state as object | null), ...extra });
  const href = useCallback(
    (s?: number, e?: number, a?: Audio, srv?: string) => {
      const resolved = d ? resolvePlaybackRequest(d, s, e, a ?? audio) : null;
      const targetKey = resolved?.media.key ?? key;
      const clampedS = resolved ? resolved.season : (clampSeason(d, s)?.number ?? s);
      const clampedE = resolved?.episode ?? e;
      return `/watch/${encodeKey(targetKey)}?${new URLSearchParams({
        ...(clampedS != null ? { s: String(clampedS) } : {}),
        ...(clampedE != null ? { e: String(clampedE) } : {}),
        ...(a ? { a } : {}),
        ...(srv ? { srv } : {}),
      })}`;
    },
    [d, key, audio],
  );
  const goEp = useCallback(
    (s: number | undefined, e: number) => nav(href(s, e, audio), { replace: true, state: forwardState({ quick: true }) }),
    [href, nav, audio, loc.state], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const goNext = useCallback(() => {
    if (!next) return;
    nav(href(next.s, next.e, audio), { replace: true, state: forwardState({ quick: true }) });
  }, [next, href, nav, audio, loc.state]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Flip sub/dub mid-episode: remember the choice for this show and resume at the same spot. */
  const switchAudio = (a: Audio) => {
    setAudioFor(canonicalKey, a, [key, d?.key]);
    nav(href(season, episode, a), { replace: true, state: forwardState({ quick: true }) });
  };

  const onProgress = useCallback(
    (position: number, duration: number) =>
      d &&
      saveProgress(
        { media: { ...d, key: canonicalKey, canonicalKey }, season, episode, audio, position, duration },
        next && { season: next.s, episode: next.e },
      ),
    [d, canonicalKey, season, episode, audio, next],
  );

  // Back returns to wherever Play was pressed. Opened from outside the app (or a reload), go to the
  // title page and replace this entry, so Back there doesn't bounce into the player again.
  const back = useCallback(() => {
    if ((loc.state as { from?: string } | null)?.from === "app") nav(-1);
    else nav(`/title/${encodeKey(canonicalKey)}`, { replace: true, viewTransition: true });
  }, [loc.state, nav, canonicalKey]);
  useEffect(() => {
    if (start) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && back();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [start, back]);
  const epLabel = episode != null ? `${season != null ? `Season ${season} · ` : ""}Episode ${episode}` : undefined;
  // Episode list for the in-player drawer.
  const episodes: EpisodeNav | undefined = useMemo(() => {
    if (!d || episode == null) return undefined;
    const playableSeasons = [...(d.seasons ?? []), ...(d.specials ?? [])].filter((s) => s.episodeCount > 0);
    const activeSeasonObj = playableSeasons.find((s) => s.number === season);
    const nextLabel = next ? next.label ?? `${next.s != null ? `S${next.s} · ` : ""}Episode ${next.e}` : undefined;
    return {
      seasons: playableSeasons.length ? playableSeasons : undefined,
      season,
      episode,
      count: activeSeasonObj?.episodeCount ?? d.episodeCount,
      loadSeason: playableSeasons.length ? (s: number) => getSeasonEpisodes(d, s) : undefined,
      loadAll: !playableSeasons.length && key.startsWith("anilist:") ? () => animeEpisodes(key) : undefined,
      go: goEp,
      fallbackStill: d.backdrop,
      nextLabel,
    };
  }, [d, key, season, episode, next, goEp]);

  if (start && session?.get(start) && d && req) {
    return (
      <Player
        key={`${reqKey(req)}:${session.createdAt}`}
        session={session}
        initialSource={start}
        title={d.title}
        subtitle={epLabel}
        startAt={
          getProgress(canonicalKey, season, episode, [key, d.key, ...courKeys])?.position ??
          (savedEntry && savedEntry.season == null && savedEntry.episode != null
            ? (() => {
                const cour = [...(d.seasons ?? []), ...(d.specials ?? [])]
                  .find((s) => s.number === season)
                  ?.cours?.find((c) => c.key === savedEntry.media.key);
                return cour && cour.startEpisode + savedEntry.episode - 1 === episode ? savedEntry.position : undefined;
              })()
            : undefined)
        }
        audio={audio}
        onAudio={isAnime || audio ? switchAudio : undefined}
        originalLanguage={d.originalLanguage}
        episodes={episodes}
        media={d}
        season={season}
        episode={episode}
        onProgress={onProgress}
        onEnded={() => settings.autoplayNext && goNext()}
        autoNext={settings.autoplayNext}
        onNext={next ? goNext : undefined}
        nextLabel={next ? (next.label ?? `${next.s != null ? `Season ${next.s} · ` : ""}Episode ${next.e}`) : undefined}
        onRetry={reloadCatalog}
        onBack={back}
      />
    );
  }

  // Catalog unreachable (offline, server down): local files and Jellyfin still only need a
  // title, which `d` already fell back to above, so this only shows when there's truly nothing.
  if (!d && detail.error) {
    return (
      <div className="race-page">
        <button className="back race-back" onClick={back}><Icon name="back" size={18} /> Back</button>
        <div className="race2 pad">
          <section className="race-hero">
            <div className="title-type md">Can't reach the catalog</div>
            <div className="resolve-empty">
              <p>AbixCine couldn't load this title's details{navigator.onLine ? "" : " because you're offline"}. Files on this PC still play once it's in Continue watching or My List.</p>
              <div className="acts">
                <button className="btn play" onClick={reloadCatalog} autoFocus><Icon name="play" size={16} /> Try again</button>
                <button className="btn glass" onClick={back}><Icon name="back" size={16} /> Back</button>
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  const total = snap?.lanes.length ?? 0;
  const answered = snap?.lanes.filter((l) => l.status !== "searching").length ?? 0;
  const pick = snap?.pick;
  const best = snap?.candidates.find((c) => c.probe?.ok);
  const empty = snap?.phase === "empty";
  const awaiting = snap?.awaitingChoice ? snap.lanes.find((l) => l.providerId === snap.awaitingChoice)?.name : undefined;
  const webPlayers = snap?.candidates.filter((c) => c.pageUrl && !c.probe?.ok).length ?? 0;
  const unanswered = snap?.lanes.filter((l) => l.status === "timeout" || l.status === "error").length ?? 0;
  const chip = [season != null ? `S${String(season).padStart(2, "0")}` : null, episode != null ? `E${String(episode).padStart(2, "0")}` : null].filter(Boolean).join(" · ");
  const thing = episode != null ? "episode" : "title";
  const inAudio = audio ? ` in ${audio === "dub" ? "English dub" : "sub"}` : "";
  const fmtMs = (ms?: number) => (ms == null || ms <= 0 ? null : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
  const pct = pick ? 1 : total ? 0.08 + (answered / total) * 0.8 : 0.2;
  const hasLocal = snap?.lanes.some((l) => l.providerId === "local");

  return (
    <div className="race-page">
      <Ambient media={d ?? undefined} />
      <div className="race-bg" aria-hidden>
        {d && <Art media={d} variant="backdrop" hd />}
        <div className="race-shade" />
      </div>
      <button className="back race-back" onClick={back}><Icon name="back" size={18} /> Back</button>

      <div className="race2 pad">
        <section className="race-hero">
          <div className="eyebrow">
            <span className="tag">Abix<b>Cine</b></span>
            {[chip, audio ? (audio === "dub" ? "English dub" : "Japanese · subtitled") : null, !chip && d?.year].filter(Boolean).join(" · ")}
          </div>
          {d ? <TitleArt media={d} size="md" /> : <div className="title-type md">Loading</div>}

          {!empty ? (
            <>
              <div className="race-status" aria-live="polite">
                <div className={`orb ${pick ? "ok" : ""}`} aria-hidden>
                  <svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="19" style={{ ["--p" as string]: pct }} /></svg>
                  {pick ? <Icon name="check" size={18} /> : <span className="orb-n">{snap?.ready ?? 0}</span>}
                </div>
                <div>
                  <div className="rmsg">
                    {pick
                      ? `Playing from ${pick.providerName}`
                      : busyKey
                        ? `Checking ${session?.get(busyKey)?.providerName ?? "that server"}`
                        : awaiting
                          ? `Waiting for ${awaiting}`
                          : total
                            ? "Finding the best stream"
                            : snap
                              ? "All servers are switched off"
                              : "Loading"}
                  </div>
                  <div className="rsub">
                    {pick
                      ? [qualityLabel(pick), viaLabel(pick), fmtMs(snap?.pickMs), snap && snap.ready > 1 ? `${snap.ready - 1} backup${snap.ready > 2 ? "s" : ""} ready` : null].filter(Boolean).join(" · ")
                      : awaiting
                        ? `Your server for this show${best ? ` · ${best.providerName} is ready if you'd rather not wait` : ""}`
                        : total
                          ? `${answered}/${total} servers answered · ${snap?.ready ?? 0} ready${snap?.waiting ? ` · ${snap.waiting} on standby` : ""}`
                          : snap
                            ? "Turn servers back on in Settings."
                            : ""}
                  </div>
                </div>
              </div>
              {note && <div className="race-note" role="status">{note}</div>}
              <div className="race-acts">
                {pick && <button className="btn play" onClick={() => setStart(candKey(pick))}><Icon name="play" size={16} /> Play now</button>}
                {!pick && best && (
                  <button className="btn play" onClick={() => session?.pickNow()}><Icon name="play" size={16} /> Play from {best.providerName} now</button>
                )}
              </div>
            </>
          ) : (
            <div className="resolve-empty">
              <h3>
                {!total
                  ? "Every server is switched off."
                  : snap?.waiting
                    ? `${snap.waiting} server${snap.waiting === 1 ? " is" : "s are"} still on standby for this ${thing}${inAudio}.`
                    : snap?.failed || unanswered
                      ? `No server could play this ${thing}${inAudio} just now.`
                      : `No server has this ${thing}${inAudio} yet.`}
              </h3>
              <p>
                {!total
                  ? "Turn some back on in Settings, add a media folder, or paste a direct link below."
                  : snap?.waiting
                    ? "Check them all, or pick one on the right to check and play it."
                    : snap?.failed || unanswered
                      ? "Servers go down and come back. Look again, or pick one on the right to retry it."
                      : audio === "dub"
                        ? "Dubs arrive later than subs, and only a few servers carry them."
                        : "It may be too new to be online yet."}
              </p>
              {note && <div className="race-note" role="status">{note}</div>}
              {hasLocal && episode != null && (
                <p className="muted hint">Looked for files named like “{d?.title} S{String(season ?? 1).padStart(2, "0")}E{String(episode).padStart(2, "0")}”, “{d?.title} - {String(absolute ?? episode).padStart(2, "0")}”, or “Season {season ?? 1}/{String(episode).padStart(2, "0")}.mkv”.</p>
              )}
              <div className="acts">
                {!total ? (
                  <button className="btn play" onClick={() => nav("/settings#sources", { viewTransition: true })}><Icon name="gear" size={16} /> Choose servers</button>
                ) : (
                  <>
                    {!!snap?.waiting && <button className="btn play" onClick={() => session?.checkAll()}><Icon name="layers" size={16} /> Check all ({snap.waiting})</button>}
                    <button className={`btn ${snap?.waiting ? "glass" : "play"}`} onClick={recheck}><Icon name="refresh" size={16} /> Look again</button>
                  </>
                )}
                {audio && <button className="btn glass" onClick={() => switchAudio(audio === "sub" ? "dub" : "sub")}>Try {audio === "sub" ? "dub" : "sub"} instead</button>}
                {webPlayers > 0 && (
                  <button
                    className="btn glass"
                    title="Opens the servers' own pages, with ads and pop-ups blocked"
                    onClick={() => {
                      const first = session?.useWebPlayers();
                      if (first) setStart(candKey(first));
                    }}
                  >
                    Use a web player
                  </button>
                )}
              </div>
              <form
                className="manual"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!manual.trim() || !session) return;
                  setStart(candKey(session.addManual(manual.trim())));
                }}
              >
                <Icon name="link" />
                <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Or paste a direct .mp4 / .m3u8 link" />
                <button className="chip" type="submit">Play</button>
              </form>
            </div>
          )}
          <div className="racebar"><i style={{ width: `${pct * 100}%` }} /></div>
        </section>

        <aside className="glass race-grid-wrap">
          <div className="h">
            <span><Icon name="layers" size={16} /> Servers</span>
            <span className="race-head-acts">
              {snap && !snap.busy && total > 0 && (
                <button type="button" className="link-btn race-recheck" onClick={recheck} title="Throw away these results and look again">
                  <Icon name="refresh" size={13} /> Look again
                </button>
              )}
              <span className={`auto ${pick ? "ok" : ""}`}>{pick ? "LOCKED" : snap?.busy ? "LIVE" : "DONE"}</span>
            </span>
          </div>
          {snap && <SourceBoard snap={snap} busyKey={busyKey} onPick={(c) => void playFrom(c)} />}
          <div className="rlog">
            {pick ? (
              <>→ <b>{pick.providerName}</b>{pick.why?.length ? ` · ${pick.why.join(", ")}` : ""}{snap?.busy ? " · backups keep checking" : ""}</>
            ) : (
              "Every server plays in AbixCine's own player: no ads, no pop-ups"
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

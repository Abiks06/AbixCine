import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Player, type EpisodeNav } from "../components/Player";
import { Art } from "../components/Art";
import { Icon } from "../components/Icon";
import { Ambient } from "../components/Ambient";
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
import { candLine, clearResolveCache, recordWin, manualCandidate, PROVIDERS, recordPlayback, resolveSources, type ResolveEvent } from "../sources/registry";
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
  const [attempt, setAttempt] = useState(0);
  const reloadCatalog = useCallback(() => {
    if (detail.error) detail.reload();
    setAttempt((n) => n + 1);
  }, [detail]);

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
  const [events, setEvents] = useState<Record<string, ResolveEvent>>({});
  /** The ranked list at the moment the picker committed to a winner. */
  const [cands, setCands] = useState<StreamCandidate[] | null>(null);
  /** Everything found so far, still updating while slower sources finish. */
  const [ranked, setRanked] = useState<StreamCandidate[]>([]);
  const [manual, setManual] = useState("");
  const [go, setGo] = useState(false);
  const [allowUnverified, setAllowUnverified] = useState(false);
  const [retry, setRetry] = useState(0);
  /** Verify every server, not just the first few (after "check the other servers"). */
  const [deep, setDeep] = useState(false);

  useEffect(() => {
    if (!req) return;
    let live = true;
    const ctl = new AbortController();
    setCands(null);
    setRanked([]);
    setEvents({});
    setGo(false);
    setAllowUnverified(false);
    resolveSources(req, (e) => live && setEvents((x) => ({ ...x, [e.providerId]: e })), {
      early: true,
      verifyBudget: deep ? 99 : 3,
      signal: ctl.signal,
      onUpdate: (r) => live && setRanked(r),
    }).then((c) => live && setCands(c));
    return () => {
      live = false;
      ctl.abort();
    };
    // Re-resolve when sources change in settings, the viewer asks to check more, or the catalog reloads.
  }, [req && reqKey(req), settings.libraryPaths, settings.jellyfin, settings.disabledSources, settings.enabledExtras, retry, deep, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (go) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && back();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, back]);
  const epLabel = episode != null ? `${season != null ? `Season ${season} · ` : ""}Episode ${episode}` : undefined;
  const playable = cands?.filter((c) => c.probe?.ok);

  /** A server the viewer asked for goes first; the rest keep their ranking. */
  const [picked, setPicked] = useState<string | undefined>(preferred);
  useEffect(() => setPicked(preferred), [preferred]);
  // The player keeps the committed order (so the current index stays put); sources that
  // answer later are appended as backup servers.
  const playerCands = useMemo(() => {
    if (!cands) return null;
    const late = ranked.filter((r) => r.probe?.ok && !cands.some((c) => c.url === r.url));
    const ok = [...cands.filter((c) => c.probe?.ok), ...late];
    const pi = picked ? ok.findIndex((c) => c.url === picked || c.pageUrl === picked || c.providerId === picked) : -1;
    if (pi > 0) ok.unshift(...ok.splice(pi, 1));
    // Then servers not checked yet (verified on demand from the player), then those that don't have it.
    const rest = ranked.filter((r) => !r.probe?.ok && !ok.some((c) => c.url === r.url));
    return [...ok, ...rest.filter((c) => !c.probe), ...rest.filter((c) => c.probe)];
  }, [cands, ranked, picked]);
  const onSourceResult = useCallback((c: StreamCandidate, ok: boolean) => {
    if (!req) return;
    recordPlayback(req, c, ok);
    // What the player saw is the strongest signal for the learned server order.
    recordWin(c.providerId, req.media.kind, ok);
    clearResolveCache();
  }, [req]);

  // Hold the race result on screen for a beat so you see which server won, then play.
  useEffect(() => {
    if (!cands?.some((c) => c.probe?.ok)) return;
    const t = setTimeout(() => setGo(true), settings.reduceMotion || quick || preferred ? 0 : 150);
    return () => clearTimeout(t);
  }, [cands]); // eslint-disable-line react-hooks/exhaustive-deps

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

  if (go && playerCands && (playerCands.some((c) => c.probe?.ok) || allowUnverified) && d && req) {
    return (
      <Player
        key={reqKey(req)}
        candidates={playerCands}
        initialSource={picked}
        onSourceResult={onSourceResult}
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
        onRetry={() => {
          setGo(false);
          reloadCatalog();
        }}
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

  const enabled = PROVIDERS.filter((p) => p.isEnabled(settings));
  const best = playable?.[0];
  const done = Object.values(events).filter((e) => e.status !== "searching").length;
  const laneBusy = (id: string) => {
    const e = events[id];
    return !e || e.status === "searching" || (e.status === "done" && (e.count ?? 0) > ranked.filter((c) => c.providerId === id).length);
  };
  const stillRacing = enabled.some((p) => laneBusy(p.id));
  const readyCount = ranked.filter((c) => c.probe?.ok).length;
  const chip = [season != null ? `S${String(season).padStart(2, "0")}` : null, episode != null ? `E${String(episode).padStart(2, "0")}` : null].filter(Boolean).join(" · ");
  /** Start right away from a server the viewer clicked on the race screen. */
  const playFrom = (c: StreamCandidate) => {
    setPicked(c.url);
    setAllowUnverified(!c.probe?.ok);
    setCands((x) => x ?? ranked);
    setGo(true);
  };
  const firstReady = ranked.find((c) => c.probe?.ok);
  const failed = !!cands && !best;
  const standby = ranked.filter((c) => !c.probe).length;
  const rejected = ranked.filter((c) => c.probe?.ok === false).length;
  const failedLookups = Object.values(events).filter((e) => e.status === "timeout" || e.status === "error").length;
  const webPlayers = ranked.filter((c) => c.pageUrl);
  /** Last resort: play the embed pages themselves, behind the ad shield. */
  const useWebPlayers = () => {
    const pages = webPlayers.map((c) => ({ ...c, url: c.pageUrl!, kind: "embed" as const, via: "embed" as const, probe: { ok: true, latencyMs: 0 } }));
    setRanked(pages);
    setCands(pages);
    setGo(true);
  };
  const pct = best ? 100 : enabled.length ? 12 + (done / enabled.length) * 78 : 30;

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

          {!failed ? (
            <>
              <div className="race-status">
                <div className={`orb ${best ? "ok" : ""}`} aria-hidden>
                  <svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="19" style={{ ["--p" as any]: pct / 100 }} /></svg>
                  {best ? <Icon name="check" size={18} /> : <span className="orb-n">{readyCount}</span>}
                </div>
                <div>
                  <div className="rmsg">
                    {best
                      ? `Playing from ${best.providerName}`
                      : enabled.length
                        ? `Finding the best server`
                        : "All servers are switched off"}
                  </div>
                  <div className="rsub">
                    {best
                      ? `${best.probe?.quality ?? best.quality ? `${best.probe?.quality ?? best.quality}p · ` : ""}${best.probe?.latencyMs ?? 0} ms${playable && playable.length > 1 ? ` · ${playable.length - 1} backup${playable.length > 2 ? "s" : ""} ready` : ""}`
                      : enabled.length
                        ? `Checking ${enabled.length} servers at once · ${readyCount} ready so far`
                        : "Turn servers back on in Settings."}
                  </div>
                </div>
              </div>
              <div className="race-acts">
                {best && <button className="btn play" onClick={() => setGo(true)}><Icon name="play" size={16} /> Play now</button>}
                {!best && firstReady && (
                  <button className="btn play" onClick={() => playFrom(firstReady)}><Icon name="play" size={16} /> Play the first ready one</button>
                )}
              </div>
            </>
          ) : (
            <div className="resolve-empty">
              <h3>
                {!enabled.length
                  ? "Every server is switched off."
                  : standby
                  ? `Some servers couldn't be checked for this ${episode != null ? "episode" : "title"}${audio ? ` in ${audio === "dub" ? "English dub" : "sub"}` : ""}.`
                  : rejected || failedLookups
                    ? `AbixCine couldn't verify a playable stream for this ${episode != null ? "episode" : "title"}${audio ? ` in ${audio === "dub" ? "English dub" : "sub"}` : ""}.`
                    : `No source returned a stream for this ${episode != null ? "episode" : "title"} this time${audio ? ` in ${audio === "dub" ? "English dub" : "sub"}` : ""}.`}
              </h3>
              <p>
                {!enabled.length
                  ? "Turn some back on in Settings, add a media folder, or paste a direct link below."
                  : standby
                    ? `${standby} source${standby > 1 ? "s are" : " is"} unverified. You can check them or try one directly.`
                    : rejected || failedLookups
                      ? "A source lookup or preflight check can fail temporarily, or reject a stream the player can still open. Retry, or try a listed source directly."
                      : audio === "dub"
                    ? "Dubs arrive later than subs, and only a few servers carry them."
                    : "It may be too new to be online yet."}
              </p>
              {enabled.some((p) => p.id === "local") && episode != null && (
                <p className="muted hint">Looked for files named like “{d?.title} S{String(season ?? 1).padStart(2, "0")}E{String(episode).padStart(2, "0")}”, “{d?.title} - {String(absolute ?? episode).padStart(2, "0")}”, or “Season {season ?? 1}/{String(episode).padStart(2, "0")}.mkv”.</p>
              )}
              <div className="acts">
                {!enabled.length ? (
                  <button className="btn play" onClick={() => nav("/settings#sources", { viewTransition: true })}><Icon name="gear" size={16} /> Choose servers</button>
                ) : standby > 0 ? (
                  <button className="btn play" onClick={() => setDeep(true)}><Icon name="layers" size={16} /> Check the other servers</button>
                ) : (
                  <button className="btn play" onClick={() => { clearResolveCache(); setRetry((n) => n + 1); }}><Icon name="refresh" size={16} /> Check again</button>
                )}
                {audio && <button className="btn glass" onClick={() => switchAudio(audio === "sub" ? "dub" : "sub")}>Try {audio === "sub" ? "dub" : "sub"} instead</button>}
                {webPlayers.length > 0 && <button className="btn glass" onClick={useWebPlayers} title="Opens the servers' own pages, with ads and pop-ups blocked">Use a web player</button>}
              </div>
              <form
                className="manual"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (manual.trim()) {
                    setRanked([]);
                    setCands([{ ...manualCandidate(manual.trim()), probe: { ok: true, latencyMs: 0 } }]);
                    setGo(true);
                  }
                }}
              >
                <Icon name="link" />
                <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Or paste a direct .mp4 / .m3u8 link" />
                <button className="chip" type="submit">Play</button>
              </form>
            </div>
          )}
          <div className="racebar"><i style={{ width: `${pct}%` }} /></div>
        </section>

        <aside className="glass race-grid-wrap">
          <div className="h">
            <span><Icon name="layers" size={16} /> Servers</span>
            <span className="auto">{!cands ? "LIVE" : stillRacing ? "PICKED" : "DONE"}</span>
          </div>
          {(() => {
            // One row per server that applies to this title, grouped by what we know about it.
            type Row = { id: string; name: string; c?: StreamCandidate; state: "ready" | "checking" | "standby" | "failed"; why?: string };
            const rows: Row[] = enabled.flatMap((p): Row[] => {
              const e = events[p.id];
              const mine = ranked.filter((c) => c.providerId === p.id);
              const top = mine.find((c) => c.probe?.ok) ?? mine.find((c) => !c.probe) ?? mine[0];
              if (top?.probe?.ok) return [{ id: p.id, name: p.name, c: top, state: "ready" }];
              if (laneBusy(p.id)) return [{ id: p.id, name: p.name, state: "checking" }];
              if (top && !top.probe) return [{ id: p.id, name: p.name, c: top, state: "standby" }];
              if (top) return [{ id: p.id, name: p.name, c: top, state: "failed", why: candLine(top) }];
              // Answered with nothing. Embed servers always apply; direct ones (HiAnime, KissKH)
              // only cover some titles, so they're hidden when they don't.
              if (e?.status === "done") return p.category === "embed" ? [{ id: p.id, name: p.name, state: "failed", why: "no matching stream returned" }] : [];
              if (e?.status === "timeout" || e?.status === "error") return [{ id: p.id, name: p.name, state: "failed", why: e.status === "timeout" ? "lookup timed out" : e.error ? `lookup failed: ${e.error}` : "lookup failed" }];
              return [];
            });
            const ready = rows
              .filter((r): r is Row & { c: StreamCandidate } => r.state === "ready" && !!r.c)
              .sort((x, y) => (y.c.score ?? 0) - (x.c.score ?? 0));
            const checking = rows.filter((r) => r.state === "checking");
            const standby = rows.filter((r) => r.state === "standby");
            const failed = rows.filter((r) => r.state === "failed");
            const tag = (c?: StreamCandidate) => (c?.audio === "dub" ? "DUB" : c?.audio === "sub" ? "SUB" : c?.audio === "dual" ? "DUAL" : null);
            return (
              <div className="rlist">
                {ready.length > 0 && <div className="rgroup-h">Ready to play · {ready.length}</div>}
                {ready.map((r, i) => {
                  const q = r.c.probe?.quality ?? r.c.quality;
                  const win = !!best && r.c.url === best.url;
                  return (
                    <button key={r.id} className={`rrow ready ${win ? "win" : ""}`} style={{ ["--i" as any]: i }} onClick={() => playFrom(r.c)} title={`Play from ${r.name}`}>
                      <span className="rdot" />
                      <span className="rname">{r.name}{win && <em className="rt-pick">PICK</em>}</span>
                      <span className="rmeta">
                        {q ? <b>{q >= 2160 ? "4K" : `${q}p`}</b> : null}
                        {tag(r.c) && <b>{tag(r.c)}</b>}
                        <span>{r.c.via === "direct" ? "direct" : "ad-free"} · {candLine(r.c).split(" · ").pop()}</span>
                      </span>
                      <span className="rt-play"><Icon name="play" size={12} /></span>
                    </button>
                  );
                })}
                {checking.length > 0 && <div className="rgroup-h">Checking · {checking.length}</div>}
                {checking.map((r) => (
                  <div key={r.id} className="rrow checking">
                    <span className="mini-spin" />
                    <span className="rname">{r.name}</span>
                    <span className="rmeta"><span>looking for the stream…</span></span>
                  </div>
                ))}
                {standby.length > 0 && (
                  <div className="rgroup-h">
                    Not checked yet · {standby.length}
                    {!stillRacing && <button className="link-btn" onClick={() => setDeep(true)}>Check them</button>}
                  </div>
                )}
                {standby.map((r) => (
                  <button key={r.id} className="rrow standby" onClick={() => r.c && playFrom(r.c)} title={`Try ${r.name} without a preflight check`}>
                    <span className="rdot" />
                    <span className="rname">{r.name}</span>
                    <span className="rmeta"><span>unverified · try anyway</span></span>
                  </button>
                ))}
                {failed.length > 0 && (
                  <details className="rfailed" open={ready.length === 0 && checking.length === 0}>
                    <summary className="rgroup-h">Couldn't use · {failed.length}</summary>
                    {failed.map((r) => (
                      <button key={r.id} className="rrow failed" onClick={() => r.c && playFrom(r.c)} title={`Try ${r.name} despite the failed preflight check`}>
                        <span className="rdot" />
                        <span className="rname">{r.name}</span>
                        <span className="rmeta"><span>{r.why} · try anyway</span></span>
                      </button>
                    ))}
                  </details>
                )}
              </div>
            );
          })()}
          <div className="rlog">
            {best ? (
              <>
                → <b>{best.providerName}</b>{best.why?.length ? ` · ${best.why.join(", ")}` : ""}
                {stillRacing ? " · others keep checking as backups" : ""}
              </>
            ) : (
              "Every server plays in AbixCine's own player: no ads, no pop-ups"
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

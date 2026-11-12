import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Player, type EpisodeNav } from "../components/Player";
import { Art } from "../components/Art";
import { Icon } from "../components/Icon";
import { Ambient } from "../components/Ambient";
import { TitleArt } from "../components/TitleArt";
import { decodeKey, encodeKey, getDetail } from "../lib/catalog";
import type { MediaDetail } from "../lib/types";
import { getEntry, getProgress, saveProgress } from "../lib/progress";
import { useWatchlist } from "../lib/watchlist";
import { audioFor, setAudioFor, useSettings, type Audio } from "../lib/settings";
import { tmdbSeason } from "../lib/tmdb";
import { animeEpisodes, animeSeasons, type AnimeSeason } from "../lib/anilist";
import { reqKey, type PlaybackRequest } from "../lib/types";
import { useAsync } from "../lib/useAsync";
import { candLine, clearResolveCache, recordWin, manualCandidate, PROVIDERS, recordPlayback, resolveSources, type ResolveEvent } from "../sources/registry";
import type { StreamCandidate } from "../sources/types";

export function Watch() {
  const key = decodeKey(useParams().key!);
  const [params] = useSearchParams();
  const nav = useNavigate();
  const loc = useLocation();
  /** Set when the player flipped sub/dub or moved episode: skip the race showcase. */
  const quick = !!(loc.state as { quick?: boolean } | null)?.quick;
  const settings = useSettings();
  const season = params.get("s") ? Number(params.get("s")) : undefined;
  const episode = params.get("e") ? Number(params.get("e")) : undefined;
  const audioParam = (params.get("a") as Audio | null) ?? undefined;
  /** A server the viewer chose on the title page or the race screen. */
  const preferred = params.get("srv") ?? undefined;
  const detail = useAsync(() => getDetail(key), [key]);
  // Offline / catalog down: local files and Jellyfin only need a title, so fall back to the copy
  // saved with progress or My List instead of spinning forever.
  const list = useWatchlist();
  const d: MediaDetail | undefined = useMemo(() => {
    if (detail.data) return detail.data;
    if (!detail.error) return undefined;
    const m = getEntry(key)?.media ?? list.find((w) => w.media.key === key)?.media;
    return m ? { ...m, cast: [], crew: [], related: [] } : undefined;
  }, [detail.data, detail.error, key, list]);
  const [attempt, setAttempt] = useState(0);
  const reloadCatalog = useCallback(() => {
    if (detail.error) detail.reload();
    setAttempt((n) => n + 1);
  }, [detail]);

  const isAnime = key.startsWith("anilist:") || d?.kind === "anime";
  const audio = audioParam ?? (isAnime ? audioFor(key) : undefined);
  // Seasons before this one, so absolute-numbered anime files ("Show - 26") still match S2E1.
  const absolute = useMemo(() => {
    if (!d?.seasons || season == null || episode == null) return undefined;
    const before = d.seasons.filter((x) => x.number > 0 && x.number < season).reduce((n, x) => n + x.episodeCount, 0);
    return before ? before + episode : undefined;
  }, [d, season, episode]);
  const req: PlaybackRequest | null = useMemo(() => (d ? { media: d, season, episode, absolute, audio } : null), [d, season, episode, absolute, audio]);
  const [events, setEvents] = useState<Record<string, ResolveEvent>>({});
  /** The ranked list at the moment the picker committed to a winner. */
  const [cands, setCands] = useState<StreamCandidate[] | null>(null);
  /** Everything found so far, still updating while slower sources finish. */
  const [ranked, setRanked] = useState<StreamCandidate[]>([]);
  const [manual, setManual] = useState("");
  const [go, setGo] = useState(false);
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
    resolveSources(req, (e) => live && setEvents((x) => ({ ...x, [e.providerId]: e })), {
      early: true,
      verifyBudget: deep ? 99 : 2,
      signal: ctl.signal,
      onUpdate: (r) => live && setRanked(r),
    }).then((c) => live && setCands(c));
    return () => {
      live = false;
      ctl.abort();
    };
    // Re-resolve when sources change in settings, the viewer asks to check more, or the catalog reloads.
  }, [req && reqKey(req), settings.libraryPaths, settings.jellyfin, settings.disabledSources, settings.enabledExtras, retry, deep, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // AniList seasons are separate entries: know the next one so the last episode leads into it.
  const aniSeasons = useAsync(() => (key.startsWith("anilist:") ? animeSeasons(key).catch(() => [] as AnimeSeason[]) : Promise.resolve([] as AnimeSeason[])), [key]);
  const nextAniSeason = useMemo(() => {
    const list = aniSeasons.data ?? [];
    const i = list.findIndex((x) => x.key === key);
    return i >= 0 ? list[i + 1] : undefined;
  }, [aniSeasons.data, key]);

  const next = useMemo((): { s?: number; e: number; key?: string; label?: string } | null => {
    if (!d || episode == null) return null;
    if (d.seasons && season != null) {
      const cur = d.seasons.find((s) => s.number === season);
      if (cur && episode < cur.episodeCount) return { s: season, e: episode + 1 };
      const ns = d.seasons.find((s) => s.number === season + 1);
      return ns ? { s: ns.number, e: 1 } : null;
    }
    if (d.episodeCount && episode < d.episodeCount) return { s: undefined, e: episode + 1 };
    if (nextAniSeason && (!d.episodeCount || episode >= d.episodeCount)) {
      const n = (aniSeasons.data ?? []).indexOf(nextAniSeason) + 1;
      return { e: 1, key: nextAniSeason.key, label: `Season ${n} · Episode 1` };
    }
    return null;
  }, [d, season, episode, nextAniSeason, aniSeasons.data]);

  // Carry the incoming navigation state (e.g. "opened from inside the app") forward, so Back
  // keeps working the same way after an in-player episode change or sub/dub switch.
  const forwardState = (extra: Record<string, unknown> = {}) => ({ ...(loc.state as object | null), ...extra });
  const href = (s?: number, e?: number, a?: Audio, srv?: string) =>
    `/watch/${encodeKey(key)}?${new URLSearchParams({
      ...(s != null ? { s: String(s) } : {}),
      ...(e != null ? { e: String(e) } : {}),
      ...(a ? { a } : {}),
      ...(srv ? { srv } : {}),
    })}`;
  const goEp = useCallback(
    (s: number | undefined, e: number) => nav(href(s, e, audio), { replace: true, state: forwardState({ quick: true }) }),
    [key, nav, audio, loc.state], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const goNext = useCallback(() => {
    if (!next) return;
    // Into the next AniList season: a different entry, same audio.
    if (next.key) nav(`/watch/${encodeKey(next.key)}?${new URLSearchParams({ e: "1", ...(audio ? { a: audio } : {}) })}`, { replace: true, state: forwardState({ quick: true }) });
    else goEp(next.s, next.e);
  }, [next, goEp, nav, audio, loc.state]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Flip sub/dub mid-episode: remember the choice for this show and resume at the same spot. */
  const switchAudio = (a: Audio) => {
    setAudioFor(key, a);
    nav(href(season, episode, a), { replace: true, state: forwardState({ quick: true }) });
  };

  const onProgress = useCallback(
    (position: number, duration: number) => d && saveProgress({ media: d, season, episode, audio, position, duration }, next && { season: next.s, episode: next.e }),
    [d, season, episode, audio, next],
  );

  // Back returns to wherever Play was pressed. Opened from outside the app (or a reload), go to the
  // title page and replace this entry, so Back there doesn't bounce into the player again.
  const back = useCallback(() => {
    if ((loc.state as { from?: string } | null)?.from === "app") nav(-1);
    else nav(`/title/${encodeKey(key)}`, { replace: true, viewTransition: true });
  }, [loc.state, nav, key]);
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
    if (!ok) clearResolveCache();
  }, [req]);

  // Hold the race result on screen for a beat so you see which server won, then play.
  useEffect(() => {
    if (!cands?.some((c) => c.probe?.ok)) return;
    const t = setTimeout(() => setGo(true), settings.reduceMotion || quick || preferred ? 0 : 750);
    return () => clearTimeout(t);
  }, [cands]); // eslint-disable-line react-hooks/exhaustive-deps

  // Episode list for the in-player drawer.
  const episodes: EpisodeNav | undefined = useMemo(() => {
    if (!d || episode == null) return undefined;
    const tmdbSeries = key.startsWith("tmdb:") && !!d.seasons?.length;
    const nextLabel = next ? next.label ?? `${next.s != null ? `S${next.s} · ` : ""}Episode ${next.e}` : undefined;
    return {
      seasons: tmdbSeries ? d.seasons : undefined,
      season,
      episode,
      count: tmdbSeries ? undefined : d.episodeCount,
      loadSeason: tmdbSeries ? (s: number) => tmdbSeason(key, s) : undefined,
      loadAll: key.startsWith("anilist:") ? () => animeEpisodes(key) : undefined,
      go: goEp,
      fallbackStill: d.backdrop,
      nextLabel,
    };
  }, [d, key, season, episode, next, goEp]);

  if (go && playerCands && playerCands.some((c) => c.probe?.ok) && d) {
    return (
      <Player
        key={reqKey(req!)}
        candidates={playerCands}
        onSourceResult={onSourceResult}
        title={d.title}
        subtitle={epLabel}
        startAt={getProgress(key, season, episode)?.position}
        audio={audio}
        onAudio={isAnime || audio ? switchAudio : undefined}
        originalLanguage={d.originalLanguage}
        episodes={episodes}
        media={d}
        onProgress={onProgress}
        onEnded={() => settings.autoplayNext && goNext()}
        autoNext={settings.autoplayNext}
        onNext={next ? goNext : undefined}
        nextLabel={next ? `${next.s != null ? `Season ${next.s} · ` : ""}Episode ${next.e}` : undefined}
        autoplayNext={settings.autoplayNext}
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
    setCands((x) => x ?? ranked);
    setGo(true);
  };
  const failed = !!cands && !best;
  const standby = ranked.filter((c) => !c.probe).length;
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
                      ? `${best.probe?.quality ?? best.quality ? `${best.probe?.quality ?? best.quality}p · ` : ""}${best.probe?.latencyMs ?? 0} ms${playable!.length > 1 ? ` · ${playable!.length - 1} backup${playable!.length > 2 ? "s" : ""} ready` : ""}`
                      : enabled.length
                        ? `Checking ${enabled.length} servers at once · ${readyCount} ready so far`
                        : "Turn servers back on in Settings."}
                  </div>
                </div>
              </div>
              <div className="race-acts">
                {best && <button className="btn play" onClick={() => setGo(true)}><Icon name="play" size={16} /> Play now</button>}
                {!best && readyCount > 0 && (
                  <button className="btn play" onClick={() => playFrom(ranked.find((c) => c.probe?.ok)!)}><Icon name="play" size={16} /> Play the first ready one</button>
                )}
              </div>
            </>
          ) : (
            <div className="resolve-empty">
              <h3>
                {!enabled.length
                  ? "Every server is switched off."
                  : standby
                  ? `The servers checked so far don't have this ${episode != null ? "episode" : "title"}${audio ? ` in ${audio === "dub" ? "English dub" : "sub"}` : ""}.`
                  : `No server has this ${episode != null ? "episode" : "title"}${audio ? ` in ${audio === "dub" ? "English dub" : "sub"}` : ""} right now.`}
              </h3>
              <p>
                {!enabled.length
                  ? "Turn some back on in Settings, add a media folder, or paste a direct link below."
                  : standby
                  ? `${standby} more server${standby > 1 ? "s are" : " is"} on standby. Checking them takes a few seconds each.`
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
              if (e?.status === "done") return p.category === "embed" ? [{ id: p.id, name: p.name, state: "failed", why: "doesn't have it" }] : [];
              if (e?.status === "timeout" || e?.status === "error") return [{ id: p.id, name: p.name, state: "failed", why: e.status === "timeout" ? "didn't answer" : "error" }];
              return [];
            });
            const ready = rows.filter((r) => r.state === "ready").sort((x, y) => (y.c!.score ?? 0) - (x.c!.score ?? 0));
            const checking = rows.filter((r) => r.state === "checking");
            const standby = rows.filter((r) => r.state === "standby");
            const failed = rows.filter((r) => r.state === "failed");
            const tag = (c?: StreamCandidate) => (c?.audio === "dub" ? "DUB" : c?.audio === "sub" ? "SUB" : c?.audio === "dual" ? "DUAL" : null);
            return (
              <div className="rlist">
                {ready.length > 0 && <div className="rgroup-h">Ready to play · {ready.length}</div>}
                {ready.map((r, i) => {
                  const q = r.c!.probe?.quality ?? r.c!.quality;
                  const win = !!best && r.c!.url === best.url;
                  return (
                    <button key={r.id} className={`rrow ready ${win ? "win" : ""}`} style={{ ["--i" as any]: i }} onClick={() => playFrom(r.c!)} title={`Play from ${r.name}`}>
                      <span className="rdot" />
                      <span className="rname">{r.name}{win && <em className="rt-pick">PICK</em>}</span>
                      <span className="rmeta">
                        {q ? <b>{q >= 2160 ? "4K" : `${q}p`}</b> : null}
                        {tag(r.c) && <b>{tag(r.c)}</b>}
                        <span>{r.c!.via === "direct" ? "direct" : "ad-free"} · {candLine(r.c!).split(" · ").pop()}</span>
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
                  <div key={r.id} className="rrow standby">
                    <span className="rdot" />
                    <span className="rname">{r.name}</span>
                    <span className="rmeta"><span>on standby</span></span>
                  </div>
                ))}
                {failed.length > 0 && (
                  <details className="rfailed" open={ready.length === 0 && checking.length === 0}>
                    <summary className="rgroup-h">Couldn't use · {failed.length}</summary>
                    {failed.map((r) => (
                      <div key={r.id} className="rrow failed">
                        <span className="rdot" />
                        <span className="rname">{r.name}</span>
                        <span className="rmeta"><span>{r.why}</span></span>
                      </div>
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

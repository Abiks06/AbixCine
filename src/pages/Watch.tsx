import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Player } from "../components/Player";
import { Art } from "../components/Art";
import { Icon } from "../components/Icon";
import { Ambient } from "../components/Ambient";
import { TitleArt } from "../components/TitleArt";
import { decodeKey, encodeKey, getDetail } from "../lib/catalog";
import type { MediaDetail } from "../lib/types";
import { getEntry, getProgress, saveProgress } from "../lib/progress";
import { watchHref } from "../lib/play";
import { useWatchlist } from "../lib/watchlist";
import { setAudioFor, useSettings, type Audio } from "../lib/settings";
import { reqKey, type PlaybackRequest } from "../lib/types";
import { useAsync } from "../lib/useAsync";
import { candLine, displayScore, manualCandidate, PROVIDERS, recordPlayback, resolveSources, type ResolveEvent } from "../sources/registry";
import type { StreamCandidate } from "../sources/types";

export function Watch() {
  const key = decodeKey(useParams().key!);
  const [params] = useSearchParams();
  const nav = useNavigate();
  const loc = useLocation();
  const settings = useSettings();
  const season = params.get("s") ? Number(params.get("s")) : undefined;
  const episode = params.get("e") ? Number(params.get("e")) : undefined;
  const a = params.get("a");
  const audio: Audio | undefined = a === "sub" || a === "dub" ? a : undefined;
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
  const retry = useCallback(() => {
    if (detail.error) detail.reload();
    setAttempt((n) => n + 1);
  }, [detail]);

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
      signal: ctl.signal,
      onUpdate: (r) => live && setRanked(r),
    }).then((c) => live && setCands(c));
    return () => {
      live = false;
      ctl.abort();
    };
    // Re-resolve when sources change in settings.
  }, [req && reqKey(req), settings.libraryPaths, settings.jellyfin, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = useMemo(() => {
    if (!d || episode == null) return null;
    if (d.seasons && season != null) {
      const cur = d.seasons.find((s) => s.number === season);
      if (cur && episode < cur.episodeCount) return { s: season, e: episode + 1 };
      const ns = d.seasons.find((s) => s.number === season + 1);
      return ns ? { s: ns.number, e: 1 } : null;
    }
    if (d.episodeCount && episode < d.episodeCount) return { s: undefined, e: episode + 1 };
    return null;
  }, [d, season, episode]);

  const href = (s?: number, e?: number, a?: Audio) => watchHref(key, s, e, a);
  const goNext = useCallback(() => {
    if (next) nav(href(next.s, next.e, audio), { replace: true, state: loc.state });
  }, [next, key, nav, audio, loc.state]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Flip sub/dub mid-episode: remember the choice for this show and resume at the same spot. */
  const switchAudio = (a: Audio) => {
    setAudioFor(key, a);
    nav(href(season, episode, a), { replace: true, state: loc.state });
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
  // The player keeps the committed order (so the current index stays put); sources that
  // answer later are appended as backup servers.
  const playerCands = useMemo(() => {
    if (!cands) return null;
    const late = ranked.filter((r) => r.probe?.ok && !cands.some((c) => c.url === r.url));
    return [...cands.filter((c) => c.probe?.ok), ...late, ...cands.filter((c) => !c.probe?.ok)];
  }, [cands, ranked]);
  const onSourceResult = useCallback((c: StreamCandidate, ok: boolean) => req && recordPlayback(req, c, ok), [req]);

  // Hold the race result on screen for a beat so you see which source won, then play.
  useEffect(() => {
    if (!cands?.some((c) => c.probe?.ok)) return;
    const t = setTimeout(() => setGo(true), settings.reduceMotion ? 0 : 900);
    return () => clearTimeout(t);
  }, [cands]); // eslint-disable-line react-hooks/exhaustive-deps

  if (go && playerCands && playable && playable.length > 0 && d) {
    return (
      <Player
        key={reqKey(req!)}
        candidates={playerCands}
        onSourceResult={onSourceResult}
        title={d.title}
        subtitle={epLabel}
        startAt={getProgress(key, season, episode)?.position}
        audio={audio}
        onAudio={audio ? switchAudio : undefined}
        media={d}
        onProgress={onProgress}
        onNext={next ? goNext : undefined}
        nextLabel={next ? `${next.s != null ? `Season ${next.s} · ` : ""}Episode ${next.e}` : undefined}
        autoplayNext={settings.autoplayNext}
        onRetry={() => {
          setGo(false);
          retry();
        }}
        onBack={back}
      />
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
  if (!d && detail.error) {
    return (
      <div className="race-page">
        <button className="back race-back" onClick={back}><Icon name="back" size={18} /> Back</button>
        <div className="race pad">
          <div className="left">
            <div className="title-type md">Can't reach the catalog</div>
            <div className="resolve-empty">
              <p>AbixCine couldn't load this title's details{navigator.onLine ? "" : " because you're offline"}. Files on this PC still play once it's in Continue watching or My List.</p>
              <div className="acts">
                <button className="btn play" onClick={retry} autoFocus><Icon name="play" size={16} /> Try again</button>
                <button className="btn glass" onClick={back}><Icon name="back" size={16} /> Back</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const failures = Object.values(events).filter((e) => e.status === "error" || e.status === "timeout");
  const chip = [season != null ? `S${String(season).padStart(2, "0")}` : null, episode != null ? `E${String(episode).padStart(2, "0")}` : null].filter(Boolean).join(" · ");
  return (
    <div className="race-page">
      <Ambient media={d ?? undefined} />
      <div className="race-bg" aria-hidden>
        {d && <Art media={d} variant="backdrop" size="lg" priority />}
        <div className="race-shade" />
      </div>
      <button className="back race-back" onClick={back}><Icon name="back" size={18} /> Back</button>
      <div className="race pad">
        <div className="left">
          <div className="eyebrow">
            <span className="tag">Abix<b>Cine</b></span>
            {[chip, audio ? (audio === "dub" ? "English dub" : "Subtitled") : null, !chip && d?.year].filter(Boolean).join(" · ")}
          </div>
          {d ? <TitleArt media={d} size="md" /> : <div className="title-type md">Loading</div>}
          {!cands || best ? (
            <>
              <div className="race-msg">
                <span className={`spin ${best ? "ok" : ""}`} />
                <div>
                  <div className="rmsg">
                    {best
                      ? `Playing from ${best.providerName}${best.probe?.quality ?? best.quality ? ` in ${best.probe?.quality ?? best.quality}p` : ""}`
                      : enabled.length
                        ? `Checking ${enabled.length} source${enabled.length > 1 ? "s" : ""} at once`
                        : "Getting ready"}
                  </div>
                  <div className="rsub">
                    {best
                      ? playable!.length > 1
                        ? `${playable!.length - 1} more on standby if anything stalls`
                        : "Starting now"
                      : "Fastest good copy wins. Usually under a second."}
                  </div>
                </div>
              </div>
              <div className="racebar"><i style={{ width: best ? "100%" : `${enabled.length ? 20 + (done / enabled.length) * 60 : 30}%` }} /></div>
            </>
          ) : (
            <div className="resolve-empty">
              <p>
                {enabled.length === 0
                  ? "AbixCine doesn't ship with streams. Point it at your own media, starting with a folder on this PC."
                  : failures.length === enabled.length
                    ? `Your source${enabled.length > 1 ? "s" : ""} didn't answer (${failures.map((f) => `${PROVIDERS.find((p) => p.id === f.providerId)?.name ?? f.providerId} ${f.status === "timeout" ? "timed out" : "errored"}`).join(", ")}).`
                    : `None of your sources has this ${episode != null ? "episode" : "title"}${audio ? ` in ${audio === "dub" ? "English dub" : "sub"}` : ""} yet.`}
              </p>
              {cands.length > 0 && <p className="muted">{cands.length} match{cands.length > 1 ? "es" : ""} found, but none responded.</p>}
              {enabled.some((p) => p.id === "local") && episode != null && (
                <p className="muted hint">Looked for files named like “{d?.title} S{String(season ?? 1).padStart(2, "0")}E{String(episode).padStart(2, "0")}”, “{d?.title} - {String(absolute ?? episode).padStart(2, "0")}”, or “Season {season ?? 1}/{String(episode).padStart(2, "0")}.mkv”.</p>
              )}
              <div className="acts">
                {enabled.length > 0 && <button className="btn play" onClick={retry}><Icon name="play" size={16} /> Search again</button>}
                <Link className={`btn ${enabled.length ? "glass" : "play"}`} to="/settings#sources" viewTransition><Icon name="folder" size={16} /> {enabled.length ? "Manage sources" : "Add a media folder"}</Link>
                {audio && <button className="btn glass" onClick={() => switchAudio(audio === "sub" ? "dub" : "sub")}>Try {audio === "sub" ? "dub" : "sub"} instead</button>}
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
                <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Or paste a direct .mp4 / .m3u8 link you have rights to" />
                <button className="chip" type="submit">Play</button>
              </form>
            </div>
          )}
        </div>

        <aside className="glass panel">
          <div className="h">
            <span><Icon name="layers" size={16} /> Source race</span>
            <span className="auto">{!cands ? "LIVE" : stillRacing ? "PICKED" : "DONE"}</span>
          </div>
          {enabled.map((p, i) => {
            const e = events[p.id];
            const mine = ranked.filter((c) => c.providerId === p.id);
            const top = mine.find((c) => c.probe?.ok) ?? mine[0];
            const st = top?.probe?.ok ? "ok" : laneBusy(p.id) ? "busy" : e?.status === "done" && !top ? "none" : "fail";
            const win = !!best && top?.url === best.url;
            return (
              <div key={p.id} className={`rl ${st} ${win ? "win" : ""}`} style={{ ["--i" as any]: i }}>
                <span className="rl-i">{i + 1}</span>
                <div className="nm">{p.name}<span className="badge">{p.category === "local" ? "Local folder" : "Optional server"}</span></div>
                <span className="st">{st === "busy" ? "probing…" : top ? candLine(top) : e?.status === "done" ? "not found" : e?.status}</span>
                <div className="tr"><i style={{ width: `${st === "busy" ? 0 : top ? Math.max(6, displayScore(top)) : 100}%` }} /></div>
              </div>
            );
          })}
          {enabled.length === 0 && (
            <div className="rl none">
              <span className="rl-i">–</span>
              <div className="nm">No sources yet<span className="badge">Add a folder in Settings</span></div>
            </div>
          )}
          <div className="rlog">
            {best ? (
              <>
                → pick <b>{best.providerName}</b> · {best.label} · score {displayScore(best)}
                {best.why?.length ? ` · ${best.why.join(", ")}` : ""}
                {stillRacing ? " · others keep racing as backups" : ""}
              </>
            ) : (
              "score = quality fit + speed + track record + last pick"
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

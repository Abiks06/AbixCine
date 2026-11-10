import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Player } from "../components/Player";
import { Art } from "../components/Art";
import { Icon } from "../components/Icon";
import { Ambient } from "../components/Ambient";
import { TitleArt } from "../components/TitleArt";
import { decodeKey, encodeKey, getDetail } from "../lib/catalog";
import { getProgress, saveProgress } from "../lib/progress";
import { setAudioFor, useSettings, type Audio } from "../lib/settings";
import { reqKey, type PlaybackRequest } from "../lib/types";
import { useAsync } from "../lib/useAsync";
import { candLine, displayScore, manualCandidate, PROVIDERS, resolveSources, type ResolveEvent } from "../sources/registry";
import type { StreamCandidate } from "../sources/types";

export function Watch() {
  const key = decodeKey(useParams().key!);
  const [params] = useSearchParams();
  const nav = useNavigate();
  const settings = useSettings();
  const season = params.get("s") ? Number(params.get("s")) : undefined;
  const episode = params.get("e") ? Number(params.get("e")) : undefined;
  const audio = (params.get("a") as Audio | null) ?? undefined;
  const { data: d } = useAsync(() => getDetail(key), [key]);

  const req: PlaybackRequest | null = useMemo(() => (d ? { media: d, season, episode, audio } : null), [d, season, episode, audio]);
  const [events, setEvents] = useState<Record<string, ResolveEvent>>({});
  const [cands, setCands] = useState<StreamCandidate[] | null>(null);
  const [manual, setManual] = useState("");
  const [go, setGo] = useState(false);

  useEffect(() => {
    if (!req) return;
    let live = true;
    setCands(null);
    setEvents({});
    setGo(false);
    resolveSources(req, (e) => live && setEvents((x) => ({ ...x, [e.providerId]: e }))).then((c) => live && setCands(c));
    return () => {
      live = false;
    };
    // Re-resolve when sources change in settings.
  }, [req && reqKey(req), settings.libraryPaths, settings.jellyfin]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const href = (s?: number, e?: number, a?: Audio) =>
    `/watch/${encodeKey(key)}?${new URLSearchParams({ ...(s != null ? { s: String(s) } : {}), ...(e != null ? { e: String(e) } : {}), ...(a ? { a } : {}) })}`;
  const goNext = useCallback(() => {
    if (next) nav(href(next.s, next.e, audio), { replace: true });
  }, [next, key, nav, audio]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Flip sub/dub mid-episode: remember the choice for this show and resume at the same spot. */
  const switchAudio = (a: Audio) => {
    setAudioFor(key, a);
    nav(href(season, episode, a), { replace: true });
  };

  const onProgress = useCallback(
    (position: number, duration: number) => d && saveProgress({ media: d, season, episode, audio, position, duration }),
    [d, season, episode, audio],
  );

  const back = () => nav(`/title/${encodeKey(key)}`, { viewTransition: true });
  const epLabel = episode != null ? `${season != null ? `Season ${season} · ` : ""}Episode ${episode}` : undefined;
  const playable = cands?.filter((c) => c.probe?.ok);

  // Hold the race result on screen for a beat so you see which source won, then play.
  useEffect(() => {
    if (!cands?.some((c) => c.probe?.ok)) return;
    const t = setTimeout(() => setGo(true), settings.reduceMotion ? 0 : 900);
    return () => clearTimeout(t);
  }, [cands]); // eslint-disable-line react-hooks/exhaustive-deps

  if (go && cands && playable && playable.length > 0 && d) {
    return (
      <Player
        key={reqKey(req!)}
        candidates={cands}
        title={d.title}
        subtitle={epLabel}
        startAt={getProgress(key, season, episode)?.position}
        audio={audio}
        onAudio={audio ? switchAudio : undefined}
        media={d}
        onProgress={onProgress}
        onEnded={() => settings.autoplayNext && goNext()}
        onNext={next ? goNext : undefined}
        onBack={back}
      />
    );
  }

  const enabled = PROVIDERS.filter((p) => p.isEnabled(settings));
  const best = playable?.[0];
  const done = Object.values(events).filter((e) => e.status !== "searching").length;
  const chip = [season != null ? `S${String(season).padStart(2, "0")}` : null, episode != null ? `E${String(episode).padStart(2, "0")}` : null].filter(Boolean).join(" · ");
  return (
    <div className="race-page">
      <Ambient media={d ?? undefined} />
      <div className="race-bg" aria-hidden>
        {d && <Art media={d} variant="backdrop" />}
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
                  : `None of your sources has this ${episode != null ? "episode" : "title"}${audio ? ` in ${audio === "dub" ? "English dub" : "sub"}` : ""} yet.`}
              </p>
              {cands.length > 0 && <p className="muted">{cands.length} match{cands.length > 1 ? "es" : ""} found, but none responded.</p>}
              <div className="acts">
                <Link className="btn play" to="/settings#sources" viewTransition><Icon name="folder" size={16} /> Add a media folder</Link>
                {audio && <button className="btn glass" onClick={() => switchAudio(audio === "sub" ? "dub" : "sub")}>Try {audio === "sub" ? "dub" : "sub"} instead</button>}
              </div>
              <form
                className="manual"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (manual.trim()) {
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
            <span className="auto">{cands ? "DONE" : "LIVE"}</span>
          </div>
          {enabled.map((p, i) => {
            const e = events[p.id];
            const mine = cands?.filter((c) => c.providerId === p.id) ?? [];
            const top = mine.find((c) => c.probe?.ok) ?? mine[0];
            const st = !e || e.status === "searching" || (!cands && e.status === "done") ? "busy" : top?.probe?.ok ? "ok" : e.status === "done" && !top ? "none" : "fail";
            const win = best && top === best;
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
              <>→ pick <b>{best.providerName}</b> · {best.label} · score {displayScore(best)}</>
            ) : (
              "score = quality fit + speed + source priority"
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

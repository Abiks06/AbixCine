import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Player } from "../components/Player";
import { Art } from "../components/Art";
import { Icon } from "../components/Icon";
import { LogoMark } from "../components/Logo";
import { TitleArt } from "../components/TitleArt";
import { decodeKey, encodeKey, getDetail } from "../lib/catalog";
import { getProgress, saveProgress } from "../lib/progress";
import { setAudioFor, useSettings, type Audio } from "../lib/settings";
import { reqKey, type PlaybackRequest } from "../lib/types";
import { useAsync } from "../lib/useAsync";
import { manualCandidate, PROVIDERS, resolveSources, type ResolveEvent } from "../sources/registry";
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

  useEffect(() => {
    if (!req) return;
    let live = true;
    setCands(null);
    setEvents({});
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

  if (cands && playable && playable.length > 0 && d) {
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
  const done = Object.values(events).filter((e) => e.status !== "searching").length;
  const tiles = d ? [d, ...(d.related ?? [])].slice(0, 9) : [];
  const chip = [season != null ? `S${String(season).padStart(2, "0")}` : null, episode != null ? `E${String(episode).padStart(2, "0")}` : null].filter(Boolean).join(" · ");
  return (
    <div className="resolver">
      <div className="collage" aria-hidden>
        {tiles.map((t, i) => (
          <div key={t.key + i} className="collage-tile" style={{ ["--i" as any]: i }}>
            <Art media={t} variant={i % 3 === 1 ? "poster" : "backdrop"} />
          </div>
        ))}
      </div>
      <div className="resolver-scrim" />
      <button className="icon-btn lg circle resolver-back" onClick={back} aria-label="Back"><Icon name="back" size={22} /></button>

      <div className="resolver-left">
        <div className="hero-tags">
          <span className="brand-chip"><LogoMark size={13} /> ABIXCINE</span>
          {chip && <span className="brand-chip">{chip}</span>}
          {audio && <span className="brand-chip ion">{audio.toUpperCase()}</span>}
        </div>
        {d ? <TitleArt media={d} size="md" /> : <div className="title-type md">Loading</div>}
        {!cands ? (
          <div className="resolve-status">
            <span className="mini-spin" />
            <div>
              <strong>{enabled.length ? `Checking ${enabled.length} source${enabled.length > 1 ? "s" : ""}` : "Getting ready"}</strong>
              <span className="muted">Picking the fastest, sharpest stream. Usually a second or two.</span>
            </div>
          </div>
        ) : (
          <div className="resolve-empty">
            <p>
              {enabled.length === 0
                ? "AbixCine doesn't ship with streams. Point it at your own media, starting with a folder on this PC."
                : `None of your sources has this ${episode != null ? "episode" : "title"}${audio ? ` in ${audio === "dub" ? "English dub" : "sub"}` : ""} yet.`}
            </p>
            {cands.length > 0 && <p className="muted">{cands.length} match(es) found but none responded.</p>}
            <div className="hero-actions">
              <Link className="btn btn-primary" to="/settings#sources" viewTransition><Icon name="folder" /> Add a media folder</Link>
              {audio && <button className="btn btn-glass" onClick={() => switchAudio(audio === "sub" ? "dub" : "sub")}>Try {audio === "sub" ? "dub" : "sub"} instead</button>}
            </div>
            <form
              className="manual"
              onSubmit={(e) => {
                e.preventDefault();
                if (manual.trim()) setCands([{ ...manualCandidate(manual.trim()), probe: { ok: true, latencyMs: 0 } }]);
              }}
            >
              <Icon name="link" />
              <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Or paste a direct .mp4 / .m3u8 link you have rights to" />
              <button className="chip" type="submit">Play</button>
            </form>
          </div>
        )}
        <div className="resolve-line"><i style={{ width: `${cands ? 100 : enabled.length ? 15 + (done / enabled.length) * 70 : 30}%` }} /></div>
      </div>

      <aside className="sources-panel">
        <div className="sp-head">
          <span className="sec-eyebrow">Sources</span>
          <span className={`sp-state ${cands ? (playable?.length ? "ok" : "none") : "busy"}`}><i />{cands ? (playable?.length ? "Ready" : "Nothing found") : "Searching"}</span>
        </div>
        {enabled.map((p, i) => {
          const e = events[p.id];
          const st = e?.status ?? "searching";
          return (
            <div key={p.id} className={`sp-row ${st}`} style={{ ["--i" as any]: i }}>
              {st === "searching" ? <span className="mini-spin" /> : <span className={`sp-dot ${st}`} />}
              <span className="sp-name">{p.name}<small>{p.category === "local" ? "This PC" : "External server"}</small></span>
              <span className="sp-res">{st === "searching" ? "Searching" : st === "done" ? `${e!.count} found` : st}</span>
            </div>
          );
        })}
        {enabled.length === 0 && <div className="sp-row"><span className="sp-dot" /><span className="sp-name">No sources yet<small>Add a folder in Settings</small></span></div>}
      </aside>
    </div>
  );
}

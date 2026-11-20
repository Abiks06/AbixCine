import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { LogoMark, Wordmark } from "../components/Logo";
import { WindowButtons } from "../components/TitleBar";
import { ApiError, continueAsGuest, errorMessage, getApiBase, hadAccount, isWaking, setApiBase, signIn, signUp, wakeServer } from "../lib/account";
import { ANIME_FEEDS, loadAnimeFeed } from "../lib/anilist";
import { setStageLight } from "../lib/light";
import type { Media } from "../lib/types";

/** Split Editorial Theater Lobby: single curated cinema frame on the left, matte check-in console on the right. */
export function Auth() {
  const [mode, setMode] = useState<"in" | "up">(() => (hadAccount() ? "in" : "up"));
  const [waking, setWaking] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [server, setServer] = useState(getApiBase());
  const [showServer, setShowServer] = useState(false);
  const [stills, setStills] = useState<Media[]>([]);
  const [slide, setSlide] = useState(0);
  const mountedRef = useRef(true);
  const wakeCtlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    loadAnimeFeed(ANIME_FEEDS[0])
      .then((list) => {
        if (!mountedRef.current) return;
        const featured = list.filter((m) => m.backdrop || m.poster).slice(0, 6);
        setStills(featured);
      })
      .catch(() => {});
    return () => {
      mountedRef.current = false;
      wakeCtlRef.current?.abort();
      wakeCtlRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (stills.length < 2) return;
    const t = window.setInterval(() => setSlide((n) => (n + 1) % stills.length), 8000);
    return () => window.clearInterval(t);
  }, [stills.length]);

  const currentStill = stills[slide % Math.max(1, stills.length)];
  useEffect(() => {
    if (currentStill) setStageLight(currentStill);
  }, [currentStill]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!setApiBase(server)) {
      setErr(errorMessage(new ApiError(400, "bad_server")));
      return;
    }
    wakeCtlRef.current?.abort();
    const ctl = new AbortController();
    wakeCtlRef.current = ctl;
    setBusy(true);
    const go = () => (mode === "up" ? signUp(name, email, password) : signIn(email, password));
    try {
      await go();
    } catch (e) {
      if (!mountedRef.current || ctl.signal.aborted) return;
      if (!isWaking(e)) {
        setErr(errorMessage(e));
      } else {
        setWaking(0);
        const up = await wakeServer((s) => mountedRef.current && !ctl.signal.aborted && setWaking(s), 90_000, ctl.signal);
        if (!mountedRef.current || ctl.signal.aborted) return;
        setWaking(null);
        if (!up) setErr(errorMessage(e));
        else await go().catch((e2) => mountedRef.current && !ctl.signal.aborted && setErr(errorMessage(e2)));
      }
    } finally {
      if (mountedRef.current && !ctl.signal.aborted) {
        setBusy(false);
        setWaking(null);
      }
    }
  };

  return (
    <div className="auth">
      <div className="auth-bar" data-tauri-drag-region>
        <WindowButtons />
      </div>

      <section className="auth-stage" aria-hidden>
        <div className="auth-media">
          {stills.map((m, idx) => {
            const url = m.backdrop ?? m.poster;
            return (
              <div
                key={m.key}
                className={`auth-slide ${idx === slide % stills.length ? "on" : ""}`}
                style={url ? { backgroundImage: `url(${url})` } : undefined}
              />
            );
          })}
          {!stills.length && <div className="auth-slide on fallback" />}
        </div>
        <div className="auth-stage-scrim" />
        <span className="gate-brackets" aria-hidden><i /></span>

        <div className="auth-pitch">
          <div className="kicker">
            <b>ABIXCINE // ARCHIVE</b>
            <i />
            <em>Private Screening Room</em>
          </div>
          <h2>Every screen.<br />One <em>cinema.</em></h2>
          <ul>
            <li>Films · Series · Anime</li>
            <li>Local vault first</li>
            <li>Sub &amp; Dub in one tap</li>
            <li>Zero ads, ever</li>
          </ul>
          {currentStill && (
            <div className="auth-caption">
              <span>STILL № {String((slide % stills.length) + 1).padStart(2, "0")}</span>
              <b>{currentStill.title}</b>
              {currentStill.year && <span>{currentStill.year}</span>}
            </div>
          )}
        </div>
      </section>

      <div className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-scroll">
            <div className="auth-brand">
              <LogoMark size={36} />
              <Wordmark />
            </div>
            <h1>{mode === "up" ? "Create account" : "Welcome back"}</h1>
            <p className="muted">{mode === "up" ? "Your watchlist, playback progress, and settings follow you across devices." : "Pick up right where you left off."}</p>

            <div className="auth-switch seg" role="tablist" aria-label="Account">
              <span className="seg-thumb" style={{ transform: `translateX(${mode === "up" ? 0 : 100}%)` }} />
              <button type="button" role="tab" aria-selected={mode === "up"} className={mode === "up" ? "on" : ""} onClick={() => { setMode("up"); setErr(null); }}>Sign up</button>
              <button type="button" role="tab" aria-selected={mode === "in"} className={mode === "in" ? "on" : ""} onClick={() => { setMode("in"); setErr(null); }}>Sign in</button>
            </div>

            <div className={`auth-fields ${mode}`}>
              {mode === "up" && (
                <label className="in-field">
                  <Icon name="user" size={16} />
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" autoComplete="nickname" />
                </label>
              )}
              <label className="in-field">
                <Icon name="mail" size={16} />
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoComplete="email" />
              </label>
              <label className="in-field">
                <Icon name="lock" size={16} />
                <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (8+ characters)" autoComplete={mode === "up" ? "new-password" : "current-password"} />
              </label>
            </div>

            {err && <div className="auth-err" role="alert">{err}</div>}
            {waking != null && (
              <div className="auth-wake" role="status">
                <span className="mini-spin" /> Waking the AbixCine server… {waking}s
                <small>Free hosting sleeps after 15 idle minutes. First sign-in of the day can take up to a minute.</small>
              </div>
            )}

            <button className="btn play wide" disabled={busy}>
              {busy ? <span className="mini-spin" /> : <>{mode === "up" ? "Create account" : "Sign in"} <Icon name="arrowR" size={16} /></>}
            </button>

            <button type="button" className="btn glass wide guest" onClick={continueAsGuest}>
              Continue without an account
            </button>
            <p className="auth-fine">Your folders and Jellyfin work offline. Progress stays on this PC until you sign in.</p>

            <button type="button" className="link-btn" onClick={() => setShowServer((s) => !s)}>
              <Icon name="globe" size={13} /> Server: {server.replace(/^https?:\/\//, "")}
            </button>
            {showServer && (
              <label className="in-field">
                <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://abixcine-api.onrender.com" aria-label="Server address" />
              </label>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

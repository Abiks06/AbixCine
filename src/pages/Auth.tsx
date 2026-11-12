import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { LogoMark, Wordmark } from "../components/Logo";
import { ApiError, continueAsGuest, errorMessage, getApiBase, hadAccount, isWaking, setApiBase, signIn, signUp, wakeServer } from "../lib/account";
import { ANIME_FEEDS, loadAnimeFeed } from "../lib/anilist";

/** Sign in / create account. A slow drifting poster wall sits behind the glass card. */
export function Auth() {
  // Returning users land on Sign in, first-timers on Sign up.
  const [mode, setMode] = useState<"in" | "up">(() => (hadAccount() ? "in" : "up"));
  /** Seconds spent waiting for a sleeping server, or null when not waiting. */
  const [waking, setWaking] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [server, setServer] = useState(getApiBase());
  const [showServer, setShowServer] = useState(false);
  // Real artwork for the wall: AniList is public, so it works before sign-in.
  const [posters, setPosters] = useState<string[]>([]);
  const mountedRef = useRef(true);
  const wakeCtlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    loadAnimeFeed(ANIME_FEEDS[0])
      .then((list) => {
        if (mountedRef.current) setPosters(list.map((m) => m.poster).filter((p): p is string => !!p));
      })
      .catch(() => {});
    return () => {
      mountedRef.current = false;
      wakeCtlRef.current?.abort();
      wakeCtlRef.current = null;
    };
  }, []);

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
        // Free hosting sleeps when idle: wait for it, then try once more, showing the wait.
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

  // 28 tiles; until posters arrive (or offline) they're tinted glass in the brand hues.
  const wall = Array.from({ length: 28 }, (_, i) => ({ poster: posters.length ? posters[i % posters.length] : undefined, hue: (i * 47) % 360 }));
  return (
    <div className="auth">
      <div className="auth-wall" aria-hidden>
        {[0, 1, 2, 3].map((col) => (
          <div key={col} className="auth-col" style={{ ["--d" as any]: `${col % 2 ? -1 : 1}`, ["--t" as any]: `${60 + col * 9}s` }}>
            {[...wall.slice(col * 7, col * 7 + 7), ...wall.slice(col * 7, col * 7 + 7)].map((m, i) => (
              <div key={i} className={`auth-tile ${m.poster ? "img" : ""}`} style={{ ["--h" as any]: m.hue, ...(m.poster ? { backgroundImage: `url(${m.poster})` } : {}) }} />
            ))}
          </div>
        ))}
      </div>
      <div className="auth-scrim" />

      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <LogoMark size={44} />
          <Wordmark />
        </div>
        <h1>{mode === "up" ? "Create your account" : "Welcome back"}</h1>
        <p className="muted">{mode === "up" ? "Your progress, list and preferences follow you to every device." : "Pick up right where you left off."}</p>

        <div className="auth-switch seg" role="tablist" aria-label="Account">
          <span className="seg-thumb" style={{ transform: `translateX(${mode === "up" ? 0 : 100}%)` }} />
          <button type="button" role="tab" aria-selected={mode === "up"} className={mode === "up" ? "on" : ""} onClick={() => setMode("up")}>Sign up</button>
          <button type="button" role="tab" aria-selected={mode === "in"} className={mode === "in" ? "on" : ""} onClick={() => setMode("in")}>Sign in</button>
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

        <button className="btn btn-ion wide" disabled={busy}>
          {busy ? <span className="mini-spin" /> : <>{mode === "up" ? "Create account" : "Sign in"} <Icon name="arrowR" size={16} /></>}
        </button>

        <button type="button" className="btn btn-glass wide guest" onClick={continueAsGuest}>
          Continue without an account
        </button>
        <p className="auth-fine">Your folders and Jellyfin work offline. Progress stays on this PC until you sign in.</p>

        <button type="button" className="link-btn" onClick={() => setShowServer((s) => !s)}>
          <Icon name="globe" size={13} /> Server: {server.replace(/^https?:\/\//, "")}
        </button>
        {showServer && (
          <label className="in-field">
            <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://abixcine-api.onrender.com" />
          </label>
        )}
      </form>
    </div>
  );
}

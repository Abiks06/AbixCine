import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { LogoMark, Wordmark } from "../components/Logo";
import { ApiError, checkServer, continueAsGuest, errorMessage, forgotPassword, getApiBase, hadAccount, isWaking, resetPassword, setApiBase, signIn, signInWith, signUp, useAuth, wakeServer } from "../lib/account";
import { demoList } from "../lib/demo";

/** Sign in / create account. A slow drifting poster wall sits behind the glass card. */
export function Auth() {
  // Returning users land on Sign in, first-timers on Sign up.
  const [mode, setMode] = useState<"in" | "up" | "forgot" | "reset">(() => (hadAccount() ? "in" : "up"));
  const { mail, oauth = [] } = useAuth();
  const [code, setCode] = useState("");
  const [note, setNote] = useState<string | null>(null);
  /** Waiting for the browser half of a Google/Discord sign-in. */
  const [external, setExternal] = useState<null | "google" | "discord">(null);
  const extAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    void checkServer(); // learn which sign-in options this server offers
    return () => extAbort.current?.abort();
  }, []);
  /** Seconds spent waiting for a sleeping server, or null when not waiting. */
  const [waking, setWaking] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [server, setServer] = useState(getApiBase());
  const [showServer, setShowServer] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!setApiBase(server)) {
      setErr(errorMessage(new ApiError(400, "bad_server")));
      return;
    }
    setBusy(true);
    setNote(null);
    const go = async () => {
      if (mode === "up") return signUp(name, email, password);
      if (mode === "in") return signIn(email, password);
      if (mode === "forgot") {
        await forgotPassword(email);
        setMode("reset");
        setNote(`If ${email} has an account, a 6-digit code is on its way. Check spam too.`);
        return;
      }
      return resetPassword(email, code, password);
    };
    try {
      await go();
    } catch (e) {
      if (!isWaking(e)) {
        setErr(errorMessage(e));
      } else {
        // Free hosting sleeps when idle: wait for it, then try once more, showing the wait.
        setWaking(0);
        const up = await wakeServer(setWaking);
        setWaking(null);
        if (!up) setErr(errorMessage(e));
        else await go().catch((e2) => setErr(errorMessage(e2)));
      }
    } finally {
      setBusy(false);
      setWaking(null);
    }
  };

  const withProvider = async (p: "google" | "discord") => {
    setErr(null);
    if (!setApiBase(server)) return setErr(errorMessage(new ApiError(400, "bad_server")));
    extAbort.current?.abort();
    const ctl = new AbortController();
    extAbort.current = ctl;
    setExternal(p);
    try {
      await signInWith(p, ctl.signal);
    } catch (e) {
      if (!ctl.signal.aborted) setErr(errorMessage(e));
    } finally {
      if (extAbort.current === ctl) setExternal(null);
    }
  };
  const providerName = (p: string) => (p === "google" ? "Google" : "Discord");
  const heading = { up: "Create your account", in: "Welcome back", forgot: "Reset your password", reset: "Choose a new password" }[mode];
  const lead = {
    up: "Your progress, list and preferences follow you to every device.",
    in: "Pick up right where you left off.",
    forgot: "We'll email you a 6-digit code.",
    reset: "Enter the code from the email and a new password. Other devices get signed out.",
  }[mode];
  const cta = { up: "Create account", in: "Sign in", forgot: "Send code", reset: "Save and sign in" }[mode];

  const wall = demoList("movie", 99, 28);
  return (
    <div className="auth">
      <div className="auth-wall" aria-hidden>
        {[0, 1, 2, 3].map((col) => (
          <div key={col} className="auth-col" style={{ ["--d" as any]: `${col % 2 ? -1 : 1}`, ["--t" as any]: `${60 + col * 9}s` }}>
            {[...wall.slice(col * 7, col * 7 + 7), ...wall.slice(col * 7, col * 7 + 7)].map((m, i) => (
              <div key={i} className="auth-tile" style={{ ["--h" as any]: m.hue }} />
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
        <h1>{heading}</h1>
        <p className="muted">{lead}</p>

        {(mode === "up" || mode === "in") && (
          <div className="auth-switch seg" role="tablist" aria-label="Account">
            <span className="seg-thumb" style={{ transform: `translateX(${mode === "up" ? 0 : 100}%)` }} />
            <button type="button" role="tab" aria-selected={mode === "up"} className={mode === "up" ? "on" : ""} onClick={() => setMode("up")}>Sign up</button>
            <button type="button" role="tab" aria-selected={mode === "in"} className={mode === "in" ? "on" : ""} onClick={() => setMode("in")}>Sign in</button>
          </div>
        )}

        {(mode === "up" || mode === "in") && oauth.length > 0 && (
          <div className="auth-oauth">
            {oauth.filter((p): p is "google" | "discord" => p === "google" || p === "discord").map((p) => (
              <button key={p} type="button" className={`btn btn-glass wide oauth ${p}`} disabled={!!external} onClick={() => withProvider(p)}>
                <span className="oauth-mark" aria-hidden>{p === "google" ? "G" : "D"}</span> Continue with {providerName(p)}
              </button>
            ))}
            {external && (
              <div className="auth-wake" role="status">
                <span className="mini-spin" /> Finish signing in with {providerName(external)} in your browser…
                <button type="button" className="link-btn" onClick={() => { extAbort.current?.abort(); setExternal(null); }}>Cancel</button>
              </div>
            )}
            <div className="auth-or"><span>or with email</span></div>
          </div>
        )}

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
          {mode === "reset" && (
            <label className="in-field">
              <Icon name="check" size={16} />
              <input inputMode="numeric" required pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="6-digit code" autoComplete="one-time-code" />
            </label>
          )}
          {mode !== "forgot" && (
            <label className="in-field">
              <Icon name="lock" size={16} />
              <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "reset" ? "New password (8+ characters)" : "Password (8+ characters)"} autoComplete={mode === "in" ? "current-password" : "new-password"} />
            </label>
          )}
        </div>
        {mode === "in" && mail !== false && (
          <button type="button" className="link-btn forgot" onClick={() => { setErr(null); setMode("forgot"); }}>Forgot password?</button>
        )}
        {(mode === "forgot" || mode === "reset") && (
          <button type="button" className="link-btn forgot" onClick={() => { setErr(null); setNote(null); setMode("in"); }}>
            <Icon name="back" size={13} /> Back to sign in
          </button>
        )}
        {note && <div className="auth-note" role="status">{note}</div>}

        {err && <div className="auth-err" role="alert">{err}</div>}
        {waking != null && (
          <div className="auth-wake" role="status">
            <span className="mini-spin" /> Waking the AbixCine server… {waking}s
            <small>Free hosting sleeps after 15 idle minutes. First sign-in of the day can take up to a minute.</small>
          </div>
        )}

        <button className="btn btn-ion wide" disabled={busy}>
          {busy ? <span className="mini-spin" /> : <>{cta} <Icon name="arrowR" size={16} /></>}
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

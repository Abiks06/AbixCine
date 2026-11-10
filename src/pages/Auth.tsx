import { useState } from "react";
import { Icon } from "../components/Icon";
import { LogoMark, Wordmark } from "../components/Logo";
import { errorMessage, getApiBase, setApiBase, signIn, signUp } from "../lib/account";
import { demoList } from "../lib/demo";

/** Sign in / create account. A slow drifting poster wall sits behind the glass card. */
export function Auth() {
  const [mode, setMode] = useState<"in" | "up">("up");
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
    setBusy(true);
    setApiBase(server);
    try {
      if (mode === "up") await signUp(name, email, password);
      else await signIn(email, password);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

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
        <h1>{mode === "up" ? "Create your account" : "Welcome back"}</h1>
        <p className="muted">{mode === "up" ? "Your progress, list and preferences follow you to every device." : "Pick up right where you left off."}</p>

        <div className="auth-switch seg" role="tablist">
          <span className="seg-thumb" style={{ transform: `translateX(${mode === "up" ? 0 : 100}%)` }} />
          <button type="button" className={mode === "up" ? "on" : ""} onClick={() => setMode("up")}>Sign up</button>
          <button type="button" className={mode === "in" ? "on" : ""} onClick={() => setMode("in")}>Sign in</button>
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

        {err && <div className="auth-err">{err}</div>}

        <button className="btn btn-ion wide" disabled={busy}>
          {busy ? <span className="mini-spin" /> : <>{mode === "up" ? "Create account" : "Sign in"} <Icon name="arrowR" size={16} /></>}
        </button>

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

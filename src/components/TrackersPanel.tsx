import { useEffect, useRef, useState } from "react";
import {
  anilistAuthorizeUrl,
  connectAnilist,
  connectSimkl,
  connectTrakt,
  disconnect,
  useScrobble,
  type DeviceCode,
  type Service,
} from "../lib/scrobble";
import { Icon } from "./Icon";

const INFO: Record<Service, { name: string; blurb: string; appUrl: string; appHelp: string }> = {
  anilist: {
    name: "AniList",
    blurb: "Moves your list's progress on as you finish episodes, and marks shows completed.",
    appUrl: "https://anilist.co/settings/developer",
    appHelp: "Create a client with redirect URL https://anilist.co/api/v2/oauth/pin, then paste its ID.",
  },
  trakt: {
    name: "Trakt",
    blurb: "Adds every film and episode you finish to your Trakt history.",
    appUrl: "https://trakt.tv/oauth/applications/new",
    appHelp: "Create an app with redirect URI urn:ietf:wg:oauth:2.0:oob, then paste its client ID and secret.",
  },
  simkl: {
    name: "SIMKL",
    blurb: "Adds films, shows and anime you finish to your SIMKL history.",
    appUrl: "https://simkl.com/settings/developer/new",
    appHelp: "Create an app (any redirect URL works for PIN sign-in), then paste its client ID.",
  },
};

function Tracker({ service }: { service: Service }) {
  const st = useScrobble();
  const conn = st.conns[service];
  const last = st.last?.[service];
  const info = INFO[service];
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    setErr(null);
    setBusy(true);
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      if (service === "anilist") {
        await connectAnilist(clientId, token);
      } else {
        const code = service === "trakt" ? await connectTrakt(clientId, secret, ctl.signal) : await connectSimkl(clientId, ctl.signal);
        setDevice(code);
        await code.done;
      }
      setToken("");
      setSecret("");
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setErr(e instanceof Error ? e.message : "Couldn't connect");
    } finally {
      setDevice(null);
      setBusy(false);
    }
  };

  return (
    <div className="source-block tracker">
      <div className="source-head">
        <Icon name="check" />
        <strong>{info.name}</strong>
        <span className={`badge ${conn ? "on" : ""}`}>{conn ? (conn.user ? `@${conn.user}` : "Connected") : "Off"}</span>
      </div>
      <p className="muted">{info.blurb}</p>
      {conn ? (
        <div className="field-row">
          <button className="btn btn-glass sm" onClick={() => disconnect(service)}>Disconnect</button>
          {last?.note && <span className={`muted ${last.ok ? "" : "warn"}`}>{last.note}</span>}
        </div>
      ) : device ? (
        <div className="tracker-code">
          <span className="muted">Open the page, sign in, and enter this code:</span>
          <code className="tracker-pin">{device.userCode}</code>
          <div className="field-row">
            <a className="btn btn-ion sm" href={device.url} target="_blank" rel="noreferrer">Open {info.name} <Icon name="arrowUR" size={13} /></a>
            <button className="btn btn-glass sm" onClick={() => abort.current?.abort()}>Cancel</button>
            <span className="muted">Waiting for approval…</span>
          </div>
        </div>
      ) : (
        <>
          <p className="muted small">
            {info.appHelp}{" "}
            <a href={info.appUrl} target="_blank" rel="noreferrer">Make one <Icon name="arrowUR" size={12} /></a>
          </p>
          <div className="field-grid">
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" autoComplete="off" spellCheck={false} />
            {service === "trakt" && <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Client secret" autoComplete="off" />}
            {service === "anilist" && <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Token from the PIN page" autoComplete="off" />}
          </div>
          <div className="field-row">
            {service === "anilist" && (
              <a
                className={`btn btn-glass sm ${clientId.trim() ? "" : "disabled"}`}
                aria-disabled={!clientId.trim()}
                href={clientId.trim() ? anilistAuthorizeUrl(clientId) : undefined}
                onClick={(e) => { if (!clientId.trim()) e.preventDefault(); }}
                target="_blank"
                rel="noreferrer"
              >
                Get a token <Icon name="arrowUR" size={13} />
              </a>
            )}
            <button
              className="btn btn-ion sm"
              onClick={start}
              disabled={busy || !clientId.trim() || (service === "trakt" && !secret.trim()) || (service === "anilist" && !token.trim())}
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
            {err && <span className="muted warn" role="alert">{err}</span>}
          </div>
        </>
      )}
    </div>
  );
}

/** Settings → Trackers: AniList, Trakt and SIMKL scrobbling. */
export function TrackersPanel() {
  return (
    <section className="panel" id="trackers">
      <h2>Trackers</h2>
      <p className="muted">
        Finish a film or an episode and it's sent to the trackers you connect here. Sign-ins stay on this PC. If you're offline, finishes wait and go up later.
      </p>
      <Tracker service="anilist" />
      <Tracker service="trakt" />
      <Tracker service="simkl" />
    </section>
  );
}

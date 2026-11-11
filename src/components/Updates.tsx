import { useEffect, useState } from "react";
import { updateSettings, useSettings } from "../lib/settings";
import { dismissWhatsNew, downloadUpdate, installUpdate, noteBlocks, releaseNotes, snoozeUpdate, useUpdates, type Release } from "../lib/updater";
import { Icon } from "./Icon";

async function openLink(url: string) {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

/** Release notes as headings, bullets and paragraphs (never raw HTML). */
export function Notes({ md, max }: { md: string; max?: number }) {
  const blocks = noteBlocks(md);
  const shown = max ? blocks.slice(0, max) : blocks;
  if (!shown.length) return <p className="muted">No notes for this release.</p>;
  return (
    <div className="notes">
      {shown.map((b, i) => (b.kind === "h" ? <h5 key={i}>{b.text}</h5> : b.kind === "li" ? <div key={i} className="li">{b.text}</div> : <p key={i}>{b.text}</p>))}
      {max && blocks.length > max && <p className="muted">…and more</p>}
    </div>
  );
}

const mb = (n: number) => `${(n / 1048576).toFixed(n > 100 * 1048576 ? 0 : 1)} MB`;

/** Bottom-right card when an update is available, downloading or ready to install. */
export function UpdateToast() {
  const u = useUpdates();
  const s = useSettings();
  const [open, setOpen] = useState(false);
  if (!u.update || u.snoozed || s.skipVersion === u.update.version) return null;
  if (!["available", "downloading", "ready", "installing", "error"].includes(u.status)) return null;
  if (u.status === "error" && !u.progress) return null;
  const pct = u.progress?.total ? Math.round((u.progress.got / u.progress.total) * 100) : null;
  return (
    <div className="glass update-toast" role="status" aria-live="polite">
      <div className="ut-head">
        <span className="ut-badge"><Icon name="spark" size={14} /></span>
        <div>
          <strong>{u.status === "ready" ? `AbixCine ${u.update.version} is ready` : `AbixCine ${u.update.version} is out`}</strong>
          <span className="muted">
            {u.status === "downloading"
              ? `Downloading${pct != null ? ` · ${pct}%` : ""}${u.progress?.total ? ` of ${mb(u.progress.total)}` : ""}`
              : u.status === "ready"
                ? "Restart to finish. Your place in anything you're watching is saved."
                : u.status === "installing"
                  ? "Installing… AbixCine will reopen by itself."
                  : u.status === "error"
                    ? "The download didn't finish. Try again."
                    : `You have ${u.current}.`}
          </span>
        </div>
        <button className="icon-btn" aria-label="Later" onClick={snoozeUpdate}><Icon name="x" size={14} /></button>
      </div>
      {u.status === "downloading" && <div className="ut-bar"><i style={{ width: `${pct ?? 30}%` }} /></div>}
      {open && <Notes md={u.update.notes} max={12} />}
      <div className="acts">
        {!u.canInstall ? (
          <button className="btn btn-ion sm" onClick={() => openLink(u.update!.url)}><Icon name="arrowUR" size={14} /> Get it</button>
        ) : u.status === "ready" ? (
          <button className="btn btn-ion sm" onClick={() => void installUpdate()}><Icon name="refresh" size={14} /> Restart now</button>
        ) : u.status === "available" || u.status === "error" ? (
          <button className="btn btn-ion sm" onClick={() => void downloadUpdate()}><Icon name="arrowR" size={14} /> Download</button>
        ) : null}
        <button className="btn glass sm" onClick={() => setOpen((o) => !o)}>{open ? "Hide notes" : "What's new"}</button>
        {u.status !== "installing" && <button className="link-btn" onClick={() => updateSettings({ skipVersion: u.update!.version })}>Skip this version</button>}
      </div>
    </div>
  );
}

/** Once, right after updating: what changed in the version you're on now. */
export function WhatsNew() {
  const u = useUpdates();
  const [rel, setRel] = useState<Release | null>(null);
  useEffect(() => {
    if (!u.whatsNew) return;
    releaseNotes()
      .then((list) => setRel(list.find((r) => r.version === u.whatsNew) ?? null))
      .catch(() => setRel(null));
  }, [u.whatsNew]);
  if (!u.whatsNew) return null;
  return (
    <div className="modal-scrim" onClick={dismissWhatsNew}>
      <div className="glass modal whats-new" role="dialog" aria-label="What's new" onClick={(e) => e.stopPropagation()}>
        <div className="eyebrow"><span className="tag">Abix<b>Cine</b></span> Updated to {u.whatsNew}</div>
        <h2>What's new</h2>
        {rel ? <Notes md={rel.notes} max={24} /> : <p className="muted">You're on the latest version.</p>}
        <div className="acts">
          <button className="btn btn-ion sm" onClick={dismissWhatsNew} autoFocus>Nice</button>
          {rel && <button className="btn glass sm" onClick={() => openLink(rel.url)}>Full release notes</button>}
        </div>
      </div>
    </div>
  );
}

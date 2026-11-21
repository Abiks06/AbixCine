import { useEffect } from "react";
import { useDownloadSetupPrompt } from "../lib/downloads";
import { Icon } from "./Icon";

/**
 * First-time Downloads folder chooser modal:
 * Lets the user pick or create their own folder first while offering a ready default path.
 */
export function DownloadFolderModal() {
  const { open, defaultDir, busy, chooseFolder, useDefault, cancel } = useDownloadSetupPrompt();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, cancel]);

  if (!open) return null;

  return (
    <div
      className="dl-modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dl-folder-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) cancel();
      }}
    >
      <div className="dl-modal glass">
        <div className="dl-modal-head">
          <span className="dl-modal-ic" aria-hidden>
            <Icon name="folder" size={20} />
          </span>
          <div>
            <p className="overline">Offline vault setup</p>
            <h2 id="dl-folder-title">Choose a Downloads folder</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            disabled={busy}
            onClick={cancel}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <p className="dl-modal-copy">
          Pick or create any folder for offline downloads, or start with the default location below.
          You will only be asked once — you can change or move this folder anytime in <strong>Settings → Sources</strong>.
          AbixCine automatically sorts saved titles into subfolders and plays them first—even without
          an internet connection.
        </p>

        <div className="dl-tree" aria-hidden>
          <div><code>Movies/</code><span>Title (Year)</span></div>
          <div><code>Series/</code><span>Title (Year) / Season 01</span></div>
          <div><code>Anime/</code><span>Title (Year) / Season 01 · Sub &amp; Dub</span></div>
        </div>

        {defaultDir && (
          <div className="dl-default-box">
            <span className="dl-default-lbl">Default location</span>
            <code>{defaultDir}</code>
          </div>
        )}

        <div className="dl-modal-acts">
          <button
            type="button"
            className="btn glass sm"
            disabled={busy}
            onClick={() => void chooseFolder()}
          >
            <Icon name="folder" size={15} /> Choose or create folder…
          </button>
          <button
            type="button"
            className="btn play sm"
            disabled={busy || !defaultDir}
            onClick={() => void useDefault()}
          >
            <Icon name="download" size={15} /> {busy ? "Setting up…" : "Use default folder"}
          </button>
        </div>
      </div>
    </div>
  );
}

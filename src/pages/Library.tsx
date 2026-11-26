import { useState } from "react";
import { Link } from "react-router-dom";
import { DownloadsVault } from "../components/DownloadsVault";
import { DriveSection } from "../components/Drive";
import { Icon } from "../components/Icon";
import { folderLabel } from "../components/TitleBar";
import { useOnlineStatus } from "../lib/online";
import { useSettings } from "../lib/settings";

/** Your vault: downloaded offline titles + media found in your local folders. */
export function Library() {
  const s = useSettings();
  const online = useOnlineStatus();
  const [rescan, setRescan] = useState(0);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          {!online && <p className="overline">Offline mode · Ready on this PC</p>}
          <h1 className="page-title">Your <em>vault</em></h1>
        </div>
        <div className="grow" />
        {s.libraryPaths.map((p) => (
          <span key={p} className="chip path" title={p}><Icon name="folder" size={14} /> <span>{folderLabel(p)}</span></span>
        ))}
        {s.libraryPaths.length > 0 && (
          <>
            <button className="btn glass sm" onClick={() => setRescan((n) => n + 1)}><Icon name="refresh" size={16} /> Rescan</button>
            <Link className="btn glass sm" to="/settings#sources" viewTransition><Icon name="plus" size={16} /> Add folder</Link>
          </>
        )}
      </div>
      <DownloadsVault showSetupWhenEmpty />
      <DriveSection rescan={rescan} bare />
    </div>
  );
}

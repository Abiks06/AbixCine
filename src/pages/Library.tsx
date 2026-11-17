import { useState } from "react";
import { Link } from "react-router-dom";
import { DriveSection } from "../components/Drive";
import { Icon } from "../components/Icon";
import { folderLabel } from "../components/TitleBar";
import { useSettings } from "../lib/settings";

/** Your drive: every title found in your media folders. */
export function Library() {
  const s = useSettings();
  const [rescan, setRescan] = useState(0);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="overline">Local first</p>
          <h1 className="page-title">Your <em>drive</em></h1>
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
      <DriveSection rescan={rescan} bare />
    </div>
  );
}

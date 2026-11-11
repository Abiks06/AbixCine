import { useEffect } from "react";
import { dismissUpdate, installUpdate, isDismissed, startUpdateChecks, useUpdate } from "../lib/updater";

/** Bottom-right card when a new version is out: release notes, then a one-click update. */
export function UpdateToast() {
  const u = useUpdate();
  useEffect(() => startUpdateChecks(), []);

  if (u.status === "available" && !isDismissed(u.version)) {
    return (
      <div className="update-toast" role="status">
        <div className="ut-h"><i />AbixCine {u.version} is ready</div>
        <p>{u.notes?.split("\n").find((l) => l.trim())?.replace(/^[#*\-\s]+/, "") || "A new version with fixes and improvements."}</p>
        <div className="ut-acts">
          <button className="btn play sm" onClick={installUpdate}>Update and restart</button>
          <button className="btn glass sm" onClick={dismissUpdate}>Later</button>
        </div>
      </div>
    );
  }
  if (u.status === "downloading" || u.status === "ready") {
    const pct = u.status === "ready" ? 100 : Math.round(u.progress * 100);
    return (
      <div className="update-toast" role="status">
        <div className="ut-h"><i />{u.status === "ready" ? "Installing" : "Downloading"} AbixCine {u.version}</div>
        <div className="ut-bar"><i style={{ width: `${pct}%` }} /></div>
        <p>{u.status === "ready" ? "AbixCine restarts in a moment." : `${pct}%`}</p>
      </div>
    );
  }
  return null;
}

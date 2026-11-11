import { Link } from "react-router-dom";
import { encodeKey } from "../lib/catalog";
import { fmtSize, qualityBadge, useDrive, type DriveTitle } from "../lib/library";
import { previewLight } from "../lib/light";
import { useSettings } from "../lib/settings";
import { Art } from "./Art";
import { Icon } from "./Icon";
import { SectionHead } from "./SectionHead";
import { folderLabel } from "./TitleBar";

const ago = (t?: number) => {
  if (!t) return "";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export function DriveTile({ t, i = 0 }: { t: DriveTitle; i?: number }) {
  const name = t.isShow ? `${t.title}${t.season ? ` S${t.season}` : ""} (${t.files.length} file${t.files.length > 1 ? "s" : ""})` : `${t.title}${t.year ? ` (${t.year})` : ""}`;
  const meta = [t.quality ? `${t.quality}p` : null, t.hdr, fmtSize(t.size), t.dual ? "Dual audio" : t.audio].filter(Boolean).join(" · ");
  const body = (
    <>
      <div className="th">
        {t.media ? <Art media={t.media} size="sm" /> : <div className="th-blank"><Icon name="film" size={20} /></div>}
      </div>
      <div className="file-body">
        <div className="t">{name}</div>
        <div className="m">{meta}</div>
        <div className="file-tags">
          <span className={`q ${qualityBadge(t.quality) === "4K" ? "" : "hd"}`}>{qualityBadge(t.quality)}</span>
          <span className="badge">LOCAL</span>
          {!t.media && <span className="badge dim">NOT MATCHED</span>}
        </div>
      </div>
    </>
  );
  return t.media ? (
    <Link
      to={`/title/${encodeKey(t.media.key)}`}
      className="file"
      style={{ ["--i" as any]: i }}
      viewTransition
      onMouseEnter={() => previewLight(t.media!)}
      onMouseLeave={() => previewLight(null)}
    >
      {body}
    </Link>
  ) : (
    <div className="file" style={{ ["--i" as any]: i }} title="AbixCine couldn't match this file to a title yet. Renaming it to “Title (Year)” helps.">
      {body}
    </div>
  );
}

/** "Local first": the user's own files, grouped into titles and matched to the catalog. */
export function DriveSection({ limit, rescan = 0 }: { limit?: number; rescan?: number }) {
  const s = useSettings();
  const drive = useDrive(rescan);
  const where = s.libraryPaths.length === 1 ? folderLabel(s.libraryPaths[0]) : s.libraryPaths.length ? `${s.libraryPaths.length} folders` : "your drive";
  const shown = limit ? drive.titles.slice(0, limit) : drive.titles;

  return (
    <section className="sec" id="drive">
      <SectionHead
        eyebrow="Local first · plays instantly, no internet needed"
        title={`From ${where}`}
        to={limit && drive.titles.length > limit ? "/library" : undefined}
        right={drive.files ? <span className="hd-note">{drive.files.toLocaleString()} files · last scan {ago(drive.at)}</span> : null}
      />
      {s.libraryPaths.length === 0 ? (
        <Link to="/settings#sources" className="drive-empty" viewTransition>
          <span className="drive-empty-ic"><Icon name="folder" size={22} /></span>
          <div>
            <strong>Add a media folder</strong>
            <span>Point AbixCine at the movies and shows already on this PC. They play first, before any server.</span>
          </div>
          <Icon name="arrowR" size={16} />
        </Link>
      ) : drive.loading && !drive.titles.length ? (
        <div className="drive">{Array.from({ length: limit ?? 6 }, (_, i) => <div key={i} className="file skeleton" />)}</div>
      ) : drive.error || (drive.warning && !drive.titles.length) ? (
        <p className="muted">Couldn't scan: {drive.error ?? drive.warning}</p>
      ) : shown.length === 0 ? (
        <p className="muted">No video files found in {where} yet.</p>
      ) : (
        <div className="drive">{shown.map((t, i) => <DriveTile key={t.id} t={t} i={i} />)}</div>
      )}
    </section>
  );
}

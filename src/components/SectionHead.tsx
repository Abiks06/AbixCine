import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";

/** A section header: mono kicker above an editorial display title (optional italic serif accent) and right tools. */
export function SectionHead({
  eyebrow,
  title,
  accentWord,
  to,
  right,
}: {
  eyebrow?: string;
  title: string;
  accentWord?: string;
  to?: string;
  right?: ReactNode;
}) {
  return (
    <header className="shelf-head">
      <div className="shelf-title">
        {eyebrow && <p className="shelf-eyebrow">{eyebrow}</p>}
        <h2>
          {title}
          {accentWord && <> <em>{accentWord}</em></>}
        </h2>
      </div>
      <div className="shelf-tools">
        {right}
        {to && (
          <Link to={to} className="more" viewTransition>
            View all <Icon name="arrowUR" size={14} />
          </Link>
        )}
      </div>
    </header>
  );
}

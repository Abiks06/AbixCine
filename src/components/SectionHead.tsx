import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";

/** A section header: optional eyebrow label, editorial display title, and right tools. */
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
        {eyebrow && <span className="shelf-eyebrow">{eyebrow}</span>}
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

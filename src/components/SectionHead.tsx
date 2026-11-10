import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";

/** Eyebrow + title + optional "View all", the header every shelf shares. */
export function SectionHead({ eyebrow, title, to, right }: { eyebrow?: string; title: string; to?: string; right?: ReactNode }) {
  return (
    <div className="row-head">
      <div className="sec-title">
        {eyebrow && <span className="sec-eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
      </div>
      <div className="row-head-right">
        {right}
        {to && (
          <Link to={to} className="pill-link" viewTransition>
            View all <Icon name="arrowUR" size={14} />
          </Link>
        )}
      </div>
    </div>
  );
}

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";

/** A shelf's header: display title, a mono caption under it, and room on the right for controls. */
export function SectionHead({ eyebrow, title, to, right }: { eyebrow?: string; title: string; to?: string; right?: ReactNode }) {
  return (
    <header className="shelf-head">
      <div className="shelf-title">
        <h2>{title}</h2>
        {eyebrow && <p>{eyebrow}</p>}
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

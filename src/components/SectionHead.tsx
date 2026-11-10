import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";

/** Eyebrow with the brand dash, a display title, and room on the right for controls. */
export function SectionHead({ eyebrow, title, to, right }: { eyebrow?: string; title: string; to?: string; right?: ReactNode }) {
  return (
    <>
      {eyebrow && <h5>{eyebrow}</h5>}
      <div className="hd">
        <h2>{title}</h2>
        <div className="hd-right">
          {right}
          {to && (
            <Link to={to} className="pill-link" viewTransition>
              View all <Icon name="arrowUR" size={14} />
            </Link>
          )}
        </div>
      </div>
    </>
  );
}

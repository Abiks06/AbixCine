import { dismissToast, pauseToast, resumeToast, useToasts } from "../lib/toast";
import { Icon } from "./Icon";

/** Renders the app-wide toast stack (see lib/toast). */
export function Toasts() {
  const list = useToasts();
  if (!list.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          className="toast"
          onMouseEnter={() => pauseToast(t.id)}
          onMouseLeave={() => resumeToast(t.id)}
          onFocus={() => pauseToast(t.id)}
          onBlur={() => resumeToast(t.id)}
        >
          {t.icon && <Icon name={t.icon} size={15} />}
          <span>{t.text}</span>
          {t.action && (
            <button
              className="toast-act"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-close" type="button" aria-label="Dismiss notification" onClick={() => dismissToast(t.id)}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

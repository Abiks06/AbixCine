import { dismissToast, useToasts } from "../lib/toast";
import { Icon } from "./Icon";

/** Renders the app-wide toast stack (see lib/toast). */
export function Toasts() {
  const list = useToasts();
  if (!list.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">
          {t.icon && <Icon name={t.icon} size={15} />}
          <span>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

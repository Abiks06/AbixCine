import { useEffect, useRef, useState } from "react";
import { createCollection, toggleInCollection, useCollections } from "../lib/collections";
import type { Media } from "../lib/types";
import { Icon } from "./Icon";

/**
 * Compact Liquid Glass popover button allowing users to add or remove a title
 * across custom named collections right from the Title page.
 */
export function CollectionPicker({
  media,
  compact = false,
  align = "left",
}: {
  media: Media & { canonicalKey?: string };
  compact?: boolean;
  align?: "left" | "right";
}) {
  const collections = useCollections();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const canonicalKey = media.canonicalKey ?? media.key;
  const memberCols = collections.filter((c) => c.keys.includes(canonicalKey) || c.keys.includes(media.key));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const created = createCollection(name);
    if (!created) return;
    if (!created.keys.includes(canonicalKey)) toggleInCollection(created.id, canonicalKey);
    setName("");
    inputRef.current?.focus();
  };

  return (
    <div className={`col-pick-wrap ${open ? "open" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className={`btn glass ${compact ? "sm" : ""} col-pick-btn ${memberCols.length > 0 ? "on" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        title="Add to custom collection"
      >
        <Icon name="folder" size={16} />
        <span>Collect</span>
        {memberCols.length > 0 && <small>{memberCols.length}</small>}
      </button>

      {open && (
        <div
          className={`col-pick-pop align-${align}`}
          role="dialog"
          aria-label={`Collections for ${media.title}`}
        >
          <div className="col-pick-head">
            <span>Collections</span>
            {memberCols.length > 0 && <small>{memberCols.length} selected</small>}
          </div>

          {collections.length > 0 ? (
            <div className="col-pick-list">
              {collections.map((c) => {
                const inCol = c.keys.includes(canonicalKey) || c.keys.includes(media.key);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`col-pick-item ${inCol ? "on" : ""}`}
                    aria-pressed={inCol}
                    onClick={() => toggleInCollection(c.id, canonicalKey)}
                  >
                    <span className="col-pick-check" aria-hidden>
                      {inCol && <Icon name="check" size={12} />}
                    </span>
                    <span className="col-pick-name">{c.name}</span>
                    <small>{c.keys.length}</small>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="col-pick-empty">Create a playlist like “Weekend Sci-Fi” or “Comfort Rewatch”.</p>
          )}

          <form className="col-pick-form" onSubmit={handleCreate}>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New collection…"
              maxLength={48}
              aria-label="New collection name"
            />
            <button type="submit" className="btn glass sm" disabled={!name.trim()}>
              <Icon name="plus" size={14} /> Add
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

import type { Media } from "../lib/types";

/**
 * The show's own title treatment when we have one, otherwise the title set as poster type.
 * `vtName` makes it a view-transition participant (the hero → title page morph).
 */
export function TitleArt({ media, size = "lg", vtName }: { media: Pick<Media, "title" | "logo">; size?: "sm" | "md" | "lg"; vtName?: string }) {
  const style = vtName ? { viewTransitionName: vtName } : undefined;
  return media.logo ? (
    <img className={`title-logo ${size}`} src={media.logo} alt={media.title} style={style} />
  ) : (
    <h1 className={`title-type ${size} ${media.title.length > 48 ? "xlong" : media.title.length > 26 ? "long" : ""}`} style={style}>{media.title}</h1>
  );
}

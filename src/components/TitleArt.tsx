import type { Media } from "../lib/types";

/** The show's own title treatment when we have one, otherwise a typeset title in the brand display style. */
export function TitleArt({ media, size = "lg" }: { media: Pick<Media, "title" | "logo">; size?: "sm" | "md" | "lg" }) {
  return media.logo ? (
    <img className={`title-logo ${size}`} src={media.logo} alt={media.title} />
  ) : (
    <h1 className={`title-type ${size}`}>{media.title}</h1>
  );
}

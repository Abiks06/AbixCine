import type { SourceProvider } from "../types";
import { anikotoProvider } from "./anikoto";
import { anizoneProvider } from "./anizone";
import { kickassanimeProvider } from "./kickassanime";
import { onetouchtvProvider } from "./onetouchtv";
import { primesrcProvider } from "./primesrc";
import { vaplayerProvider } from "./vaplayer";
import { vidlinkProvider } from "./vidlink";
import { vidrockProvider } from "./vidrock";
import { vixsrcProvider } from "./vixsrc";
import { zxcstreamsProvider } from "./zxcstreams";

export { anikotoProvider } from "./anikoto";
export { anizoneProvider } from "./anizone";
export { kickassanimeProvider } from "./kickassanime";
export { onetouchtvProvider } from "./onetouchtv";
export { primesrcProvider } from "./primesrc";
export { vaplayerProvider } from "./vaplayer";
export { vidlinkProvider } from "./vidlink";
export { vidrockProvider } from "./vidrock";
export { vixsrcProvider } from "./vixsrc";
export { zxcstreamsProvider } from "./zxcstreams";

export const MOVIE_TV_EXTRACTORS: SourceProvider[] = [
  vidlinkProvider,
  vidrockProvider,
  zxcstreamsProvider,
  vixsrcProvider,
  vaplayerProvider,
  primesrcProvider,
];

export const ANIME_EXTRACTORS: SourceProvider[] = [
  anizoneProvider,
  kickassanimeProvider,
  anikotoProvider,
];

export const ASIAN_DRAMA_EXTRACTORS: SourceProvider[] = [
  onetouchtvProvider,
];

export const DIRECT_EXTRACTORS: SourceProvider[] = [
  ...MOVIE_TV_EXTRACTORS,
  ...ANIME_EXTRACTORS,
  ...ASIAN_DRAMA_EXTRACTORS,
];

import type { SourceProvider } from "../types";
import { animeheavenProvider } from "./animeheaven";
import { anikotoProvider } from "./anikoto";
import { anizoneProvider } from "./anizone";
import { castleProvider } from "./castle";
import { cinejoyProvider } from "./cinejoy";
import { flixnestProvider } from "./flixnest";
import { hexaProvider } from "./hexa";
import { kickassanimeProvider } from "./kickassanime";
import { megaplayProvider } from "./megaplay";
import { meowtvProvider } from "./meowtv";
import { onetouchtvProvider } from "./onetouchtv";
import { vidlinkProvider } from "./vidlink";
import { vidrockProvider } from "./vidrock";
import { vixsrcProvider } from "./vixsrc";
import { zxcstreamsProvider } from "./zxcstreams";

export { animeheavenProvider } from "./animeheaven";
export { anikotoProvider } from "./anikoto";
export { anizoneProvider } from "./anizone";
export { castleProvider } from "./castle";
export { cinejoyProvider } from "./cinejoy";
export { flixnestProvider } from "./flixnest";
export { hexaProvider } from "./hexa";
export { kickassanimeProvider } from "./kickassanime";
export { megaplayProvider } from "./megaplay";
export { meowtvProvider } from "./meowtv";
export { onetouchtvProvider } from "./onetouchtv";
export { vidlinkProvider } from "./vidlink";
export { vidrockProvider } from "./vidrock";
export { vixsrcProvider } from "./vixsrc";
export { zxcstreamsProvider } from "./zxcstreams";

export const MOVIE_TV_EXTRACTORS: SourceProvider[] = [
  zxcstreamsProvider,
  vidrockProvider,
  castleProvider,
  vixsrcProvider,
  vidlinkProvider,
  flixnestProvider,
  hexaProvider,
  cinejoyProvider,
  meowtvProvider,
];

export const ANIME_EXTRACTORS: SourceProvider[] = [
  megaplayProvider,
  anizoneProvider,
  kickassanimeProvider,
  anikotoProvider,
  animeheavenProvider,
];

export const ASIAN_DRAMA_EXTRACTORS: SourceProvider[] = [
  onetouchtvProvider,
];

export const DIRECT_EXTRACTORS: SourceProvider[] = [
  ...MOVIE_TV_EXTRACTORS,
  ...ANIME_EXTRACTORS,
  ...ASIAN_DRAMA_EXTRACTORS,
];

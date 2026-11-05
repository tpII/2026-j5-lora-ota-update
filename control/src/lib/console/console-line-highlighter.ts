/**
 * Colors the JSON of console lines with Shiki. Only the JSON grammar and one dark theme, written
 * here with the colors of the panel, are loaded. The grammar comes precompiled, with its regular expressions already written for
 * JavaScript, so the raw engine runs it without WebAssembly and without the converter of
 * Oniguruma expressions: the highlighter starts synchronously and the bundle stays small.
 */
import json from "@shikijs/langs-precompiled/json";
import {
  createHighlighterCoreSync,
  getTokenStyleObject,
  stringifyTokenStyle,
  type HighlighterCore,
  type ThemeRegistration,
} from "shiki/core";
import { createJavaScriptRawEngine } from "shiki/engine/javascript";

/** A piece of a line drawn with one style. */
export interface HighlightedSegment {
  readonly text: string;
  /** Inline CSS of the segment, for example "color:#0451A5". */
  readonly style: string;
}

const THEME = "j5-neon";

/** Keys in the neon of the panel, strings in green, numbers in amber, literals in magenta. */
const NEON_THEME: ThemeRegistration = {
  name: THEME,
  type: "dark",
  fg: "#98B0B8",
  bg: "#020405",
  settings: [
    { settings: { foreground: "#98B0B8" } },
    { scope: ["support.type.property-name.json"], settings: { foreground: "#5CE1F0" } },
    { scope: ["string.quoted.double.json", "string"], settings: { foreground: "#9EF0B8" } },
    { scope: ["constant.numeric"], settings: { foreground: "#FFC86B" } },
    { scope: ["constant.language"], settings: { foreground: "#FF7AC0" } },
    { scope: ["punctuation"], settings: { foreground: "#6F868E" } },
  ],
};

/** Lines kept already colored; the panel keeps 3000 lines and draws at most 500. */
const MAXIMUM_CACHED_LINES = 2000;

let highlighter: HighlighterCore | null = null;
const cache = new Map<string, readonly HighlightedSegment[]>();

function highlighterInstance(): HighlighterCore {
  highlighter ??= createHighlighterCoreSync({
    themes: [NEON_THEME],
    langs: [json],
    engine: createJavaScriptRawEngine(),
  });
  return highlighter;
}

function colorLine(line: string): HighlightedSegment[] {
  const segments: HighlightedSegment[] = [];
  const tokens = highlighterInstance().codeToTokensBase(line, { lang: "json", theme: THEME });
  for (const token of tokens.flat()) {
    const style = stringifyTokenStyle(getTokenStyleObject(token));
    const previous = segments.at(-1);
    // Neighbors with the same style become one segment, so the page draws fewer elements.
    if (previous !== undefined && previous.style === style) {
      segments[segments.length - 1] = { text: previous.text + token.content, style };
    } else {
      segments.push({ text: token.content, style });
    }
  }
  return segments;
}

/** The segments of a console line, colored as JSON. A line that is not JSON keeps its text. */
export function highlightJsonLine(line: string): readonly HighlightedSegment[] {
  const cached = cache.get(line);
  if (cached !== undefined) {
    return cached;
  }
  const segments = colorLine(line);
  if (cache.size >= MAXIMUM_CACHED_LINES) {
    // A Map keeps insertion order: the first key is the oldest line.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(line, segments);
  return segments;
}

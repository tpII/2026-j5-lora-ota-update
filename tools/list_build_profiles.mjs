// Prints the build profiles of firmware/sketch.yaml, one per line, in the order of the file: the
// board builds of mise.toml and tools/generate_clangd_configuration.py read them from here, and
// the generator of the protocol sources checks that they are the buildProfile of the board models
// of the contract.
//
// Usage: node tools/list_build_profiles.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKETCH_PROJECT_PATH = join(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  "firmware",
  "sketch.yaml",
);

/**
 * The names under the top-level profiles key of a sketch project file, which arduino-cli writes
 * with two spaces of indentation.
 * @param {string} text
 * @returns {string[]}
 */
export function listBuildProfiles(text) {
  const profiles = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inside = line.startsWith("profiles:");
      continue;
    }
    const match = inside ? /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line) : null;
    if (match !== null) {
      profiles.push(match[1]);
    }
  }
  return profiles;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profiles = listBuildProfiles(readFileSync(SKETCH_PROJECT_PATH, "utf8"));
  if (profiles.length === 0) {
    console.error(`${SKETCH_PROJECT_PATH} lists no build profile`);
    process.exitCode = 1;
  }
  console.log(profiles.join("\n"));
}

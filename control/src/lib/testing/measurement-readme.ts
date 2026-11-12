/**
 * The tables of docs/measurement-exports.md, which documents the files of every export, for the tests
 * that check the exports against it.
 */
import measurementReadme from "../../../../docs/measurement-exports.md?raw";

/**
 * The names in the first column of the first table after `heading` in docs/measurement-exports.md, in
 * order; a row such as "| `sender`, `receiver` | … |" names two.
 */
export function readmeNamesUnder(heading: string): string[] {
  const lines = measurementReadme.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) {
    throw new Error(`docs/measurement-exports.md has no heading ${heading}`);
  }
  const names: string[] = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("|")) {
      if (inTable) {
        break;
      }
      continue;
    }
    inTable = true;
    const firstCell = line.split("|")[1] ?? "";
    names.push(...[...firstCell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!));
  }
  return names;
}

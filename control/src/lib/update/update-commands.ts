/**
 * The `load_image` and `activate` commands of the updates, as the panel records them when it sends
 * them, and how a node answers a `load_image`. The update metrics start from these records.
 */
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import { ACTIVATE_COMMAND, LOAD_IMAGE_COMMAND } from "$lib/commands/console-command.ts";
import { commandWordsOf } from "$lib/console/console-command-table.ts";
import { isImageVersion, readImageVersion } from "$lib/image/image-format.ts";
import { parseHex } from "$lib/utils/hex.ts";
import type { NodeErrorRecord } from "$lib/nodes/error-records.ts";
import type { NodeState } from "$lib/node-session/node-state.ts";
import { IMAGE_HEADER_SIZE } from "$lib/protocol/protocol-contract.ts";

/** A command of the update, with the version it carries. */
export type UpdateCommand =
  | { readonly kind: "load_image"; readonly version: number }
  | { readonly kind: "activate"; readonly version: number };

/** An update command sent to a connection, with the host time at which the panel sent it. */
export interface UpdateCommandRecord {
  readonly connectionKey: string;
  /** Node behind the connection when the command left, if already identified. */
  readonly node: NodeIdentifier | null;
  readonly hostTime: number;
  readonly command: UpdateCommand;
  /**
   * Only for `load_image`: true once the node accepted it, false once it rejected it, absent while
   * it has not answered (see loadResponseOf). A rejected load starts no update.
   */
  readonly accepted?: boolean;
}

/** How a node answered a `load_image`. */
export type LoadResponse =
  | { readonly kind: "waiting" }
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly error: NodeErrorRecord };

/**
 * How the node of `state` answered a `load_image` of `version` sent at `hostTime`: it accepts the
 * image with an `image` event of the version with `via: "console"`, and rejects it with an `error`
 * of `load_image`.
 */
export function loadResponseOf(
  state: NodeState,
  load: { readonly version: number; readonly hostTime: number },
): LoadResponse {
  const accepted = state.images.some(
    (record) =>
      record.version === load.version &&
      record.via === "console" &&
      record.hostTime >= load.hostTime,
  );
  if (accepted) {
    return { kind: "accepted" };
  }
  const error = state.errors.findLast(
    (record) => record.command === LOAD_IMAGE_COMMAND && record.hostTime >= load.hostTime,
  );
  return error === undefined ? { kind: "waiting" } : { kind: "rejected", error };
}

/**
 * Records the answer of every `load_image` sent to `connectionKey` that was still waiting, from the
 * state of its node. Returns the same list when no answer is new.
 */
export function settleLoadResponses(
  commands: readonly UpdateCommandRecord[],
  connectionKey: string,
  state: NodeState,
): readonly UpdateCommandRecord[] {
  let settled: UpdateCommandRecord[] | null = null;
  for (const [index, record] of commands.entries()) {
    if (
      record.connectionKey !== connectionKey ||
      record.command.kind !== "load_image" ||
      record.accepted !== undefined
    ) {
      continue;
    }
    const response = loadResponseOf(state, {
      version: record.command.version,
      hostTime: record.hostTime,
    });
    if (response.kind !== "waiting") {
      settled ??= [...commands];
      settled[index] = { ...record, accepted: response.kind === "accepted" };
    }
  }
  return settled ?? commands;
}

function isAcceptedLoad(record: UpdateCommandRecord): boolean {
  return record.command.kind === "load_image" && record.accepted === true;
}

/**
 * Versions a node accepted with `load_image`, in the order the panel first sent them: a rejected
 * load starts no update.
 */
export function loadedUpdateVersions(commands: readonly UpdateCommandRecord[]): number[] {
  const versions: number[] = [];
  for (const record of commands) {
    if (isAcceptedLoad(record) && !versions.includes(record.command.version)) {
      versions.push(record.command.version);
    }
  }
  return versions;
}

/**
 * The first accepted `load_image` of `version`, the first `activate` of it that followed and the
 * first accepted `load_image` of another version after it, which ends the update. Null when no
 * node accepted the version.
 */
export function updateCommandTimesOf(
  commands: readonly UpdateCommandRecord[],
  version: number,
): {
  readonly loadHostTime: number;
  readonly activateHostTime: number | null;
  readonly endHostTime: number | null;
} | null {
  const load = commands.find(
    (record) => isAcceptedLoad(record) && record.command.version === version,
  );
  if (load === undefined) {
    return null;
  }
  const activate = commands.find(
    (record) =>
      record.command.kind === "activate" &&
      record.command.version === version &&
      record.hostTime >= load.hostTime,
  );
  const next = commands.find(
    (record) =>
      isAcceptedLoad(record) &&
      record.command.version !== version &&
      record.hostTime > load.hostTime,
  );
  return {
    loadHostTime: load.hostTime,
    activateHostTime: activate?.hostTime ?? null,
    endHostTime: next?.hostTime ?? null,
  };
}

/**
 * The update command of a line the operator typed in the event stream, or null for any other
 * command. The panel records the commands it builds itself as it sends them; only a typed
 * `load_image` needs its version read back from the header of the image.
 */
export function parseTypedUpdateCommand(commandLine: string): UpdateCommand | null {
  const words = commandWordsOf(commandLine);
  const word = words[0];
  if (word === ACTIVATE_COMMAND && words.length === 2) {
    const version = Number(words[1]);
    return isImageVersion(version) ? { kind: "activate", version } : null;
  }
  if (word === LOAD_IMAGE_COMMAND && words.length === 2) {
    const header = parseHex((words[1] ?? "").slice(0, 2 * IMAGE_HEADER_SIZE));
    if (header === null || header.length < IMAGE_HEADER_SIZE) {
      return null;
    }
    return { kind: "load_image", version: readImageVersion(header) };
  }
  return null;
}

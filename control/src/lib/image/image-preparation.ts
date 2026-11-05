/**
 * What the panel checks before it signs an image and loads it on a node (docs/protocol/image.md
 * and ADR 0011): the version, against the node and the rest of the connection graph, and the
 * program a node returned with `program`, for a rollback.
 */
import type { ConnectionGraph } from "$lib/nodes/connection-graph.ts";
import {
  MAXIMUM_PROGRAM_SIZE,
  MINIMUM_PROGRAM_SIZE,
  isImageVersion,
  parseHex,
  proposeImageVersion,
} from "./image-format.ts";

/** A version this far ahead of the computer's clock is probably a typing mistake. */
export const FUTURE_VERSION_TOLERANCE_SECONDS = 3600;

/** The line of firmware/build_opt.h that compiles `publicKey` as the operator public key. */
export function operatorKeyDefinition(publicKey: string): string {
  return `-DJ5_OPERATOR_PUBLIC_KEY="\\"${publicKey}\\""`;
}

/** Highest available version that some node of the graph announces; null when none is known. */
export function highestAvailableVersion(graph: ConnectionGraph): number | null {
  let highest: number | null = null;
  for (const node of graph.nodes) {
    if (node.availableVersion !== null) {
      highest = highest === null ? node.availableVersion : Math.max(highest, node.availableVersion);
    }
  }
  return highest;
}

export interface ImageVersionCheck {
  /** False when the node would reject the image: the panel does not send it. */
  readonly acceptable: boolean;
  /** Why the node would reject it, in Spanish; null when acceptable. */
  readonly problem: string | null;
  /** What deserves the operator's attention even if the node accepts it, in Spanish. */
  readonly warnings: readonly string[];
}

export interface ImageVersionContext {
  /** Available version of the node that receives `load_image`; null when unknown. */
  readonly targetAvailableVersion: number | null;
  /** Highest available version announced in the connection graph; null when unknown. */
  readonly networkAvailableVersion: number | null;
  /** Milliseconds since 1970 on the computer. */
  readonly nowMilliseconds: number;
}

/**
 * Checks the version of an image before it is signed. A node only accepts a version greater than
 * its available version; the rest of the network ignores versions not greater than its own.
 */
export function checkImageVersion(
  version: number,
  context: ImageVersionContext,
): ImageVersionCheck {
  if (!isImageVersion(version)) {
    return {
      acceptable: false,
      problem: "La versión es un entero de 1 a 4294967295.",
      warnings: [],
    };
  }
  const { targetAvailableVersion, networkAvailableVersion, nowMilliseconds } = context;
  if (targetAvailableVersion !== null && version <= targetAvailableVersion) {
    return {
      acceptable: false,
      problem: `El nodo ya tiene disponible la versión ${targetAvailableVersion}: solo acepta una mayor.`,
      warnings: [],
    };
  }
  const warnings: string[] = [];
  if (targetAvailableVersion === null) {
    warnings.push(
      "No se conoce la versión disponible del nodo: conviene consultar su estado antes de cargar.",
    );
  }
  if (networkAvailableVersion !== null && version <= networkAvailableVersion) {
    warnings.push(
      `Algún nodo del grafo ya tiene disponible la versión ${networkAvailableVersion}: esos nodos van a ignorar esta imagen.`,
    );
  }
  if (version > proposeImageVersion(nowMilliseconds) + FUTURE_VERSION_TOLERANCE_SECONDS) {
    warnings.push(
      "La versión supera la hora actual de la computadora: le va a ganar a toda imagen firmada con la hora correcta hasta que se reinicie toda la red.",
    );
  }
  return { acceptable: true, problem: null, warnings };
}

export type ProgramRecovery =
  | { readonly valid: true; readonly program: Uint8Array<ArrayBuffer> }
  | { readonly valid: false; readonly message: string };

/** The bytes of the `code` of a `program` event, ready to sign again with another version. */
export function recoverProgram(code: string): ProgramRecovery {
  const program = parseHex(code);
  if (program === null) {
    return { valid: false, message: "El código del programa no es hexadecimal." };
  }
  if (program.length < MINIMUM_PROGRAM_SIZE) {
    return {
      valid: false,
      message:
        "La versión 0 es el programa de fábrica, que está vacío y no se puede firmar. Para volver a un programa que no hace nada, cargar uno con solo HALT.",
    };
  }
  if (program.length > MAXIMUM_PROGRAM_SIZE) {
    return {
      valid: false,
      message: `El programa ocupa ${program.length} bytes y una imagen admite ${MAXIMUM_PROGRAM_SIZE}.`,
    };
  }
  return { valid: true, program };
}

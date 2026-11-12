/**
 * The workflow of the update section on the node chosen above: it owns the operator's signing
 * session and the record of the update commands, signs and loads images, orders the activation and
 * tells how the node answered.
 */
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import { buildActivateCommand, buildLoadImageCommand } from "$lib/commands/console-command.ts";
import { checkImageVersion, type ImageVersionCheck } from "$lib/image/image-preparation.ts";
import {
  highestAvailableVersion,
  type ConnectionGraph,
} from "$lib/node-session/connection-graph.ts";
import type { ConnectionView, IdentifiedConnection } from "$lib/node-session/connection-view.ts";
import { describeError } from "$lib/utils/error-description.ts";
import type { TimeSource } from "$lib/utils/time-source.ts";
import { ACTIVATION_VERSION_RANGE_PROBLEM, activationProblem } from "./activation.ts";
import { ImageSigningSession } from "./image-signing-session.svelte.ts";
import { loadResponseOf, type LoadResponse } from "./update-commands.ts";
import { UpdateRecord, type UpdateRecordOptions } from "./update-record.svelte.ts";

/** What the controller reads from the panel. */
export interface UpdatePanel {
  readonly nodes: {
    /** The node chosen above, when it takes commands. */
    readonly selectedIdentified: IdentifiedConnection | null;
    byKey(key: string): ConnectionView | null;
  };
  readonly connectionGraph: ConnectionGraph;
  /** Host time, updated every second, so that the version checks follow the clock. */
  readonly now: number;
}

/** The last image the panel sent to a node with `load_image`. */
export interface LoadAttempt {
  /** Key of the connection it went through. */
  readonly key: string;
  readonly node: NodeIdentifier;
  readonly version: number;
  readonly imageSize: number;
  readonly hostTime: number;
}

/** How the node answered the last load, or "unknown" once its connection is gone. */
export type LoadAttemptResponse = LoadResponse | { readonly kind: "unknown" };

/** The node chosen verifies with the other kind of operator key than the one loaded. */
export interface OperatorKeyMismatch {
  readonly node: NodeIdentifier;
  readonly nodeKeyIsDefault: boolean;
}

export class UpdateController {
  readonly session: ImageSigningSession;
  /** The update commands sent since the measurement record was cleared, and their metrics. */
  readonly record: UpdateRecord;
  lastLoad = $state.raw<LoadAttempt | null>(null);

  readonly #panel: UpdatePanel;

  /** `record` says where the commands go and what they are measured with. */
  constructor(
    panel: UpdatePanel,
    record: UpdateRecordOptions & { readonly timeSource: TimeSource },
  ) {
    this.#panel = panel;
    this.session = new ImageSigningSession(record.timeSource);
    this.record = new UpdateRecord(record);
  }

  /** The origin of every action of the section: the node chosen above, when it takes commands. */
  get target(): IdentifiedConnection | null {
    return this.#panel.nodes.selectedIdentified;
  }

  /** How the node chosen and the rest of the graph would take an image of `version`. */
  checkVersion(version: number): ImageVersionCheck {
    return checkImageVersion(version, {
      targetAvailableVersion: this.target?.state.availableVersion ?? null,
      networkAvailableVersion: highestAvailableVersion(this.#panel.connectionGraph),
      nowMilliseconds: this.#panel.now,
    });
  }

  get lastLoadResponse(): LoadAttemptResponse | null {
    const attempt = this.lastLoad;
    if (attempt === null) {
      return null;
    }
    const state = this.#panel.nodes.byKey(attempt.key)?.state;
    return state === undefined ? { kind: "unknown" } : loadResponseOf(state, attempt);
  }

  /** The operator key of the node chosen, when it differs from the loaded one. */
  get operatorKeyMismatch(): OperatorKeyMismatch | null {
    const key = this.session.key;
    const target = this.target;
    if (key === null || target === null || target.state.operatorKey === null) {
      return null;
    }
    const nodeKeyIsDefault = target.state.operatorKey === "default";
    return key.isDefault === nodeKeyIsDefault
      ? null
      : { node: target.state.identifier, nodeKeyIsDefault };
  }

  /**
   * Signs `program` with `version` and sends `load_image` to the node chosen. Returns the problem
   * in Spanish, or null once the command left; the answer arrives in `lastLoadResponse`.
   */
  async loadImage(program: Uint8Array, version: number): Promise<string | null> {
    const connection = this.target;
    if (connection === null) {
      return "No hay un nodo conectado e identificado elegido.";
    }
    let image: Uint8Array;
    try {
      image = (await this.session.sign(program, version)).image;
    } catch (error) {
      return `No se pudo firmar la imagen: ${describeError(error)}`;
    }
    const result = buildLoadImageCommand(image);
    if (!result.valid) {
      return result.problems.map((problem) => problem.message).join(" ");
    }
    const record = await this.record.send(
      connection.key,
      { kind: "load_image", version },
      result.command,
    );
    if (record === null) {
      return "No se pudo enviar la imagen al nodo.";
    }
    this.lastLoad = {
      key: connection.key,
      node: connection.state.identifier,
      version,
      imageSize: image.length,
      hostTime: record.hostTime,
    };
    this.session.advanceVersionPast(version);
    return null;
  }

  /**
   * Why the node chosen would answer `activate` with an error, in Spanish; null when it would
   * accept it. A null `version` is a field left empty.
   */
  activationProblem(version: number | null): string | null {
    const target = this.target;
    if (target === null) {
      return "Falta elegir arriba un nodo conectado e identificado.";
    }
    return version === null
      ? ACTIVATION_VERSION_RANGE_PROBLEM
      : activationProblem(target.state, version);
  }

  /** Sends `activate` with `version` to the node chosen; false when it did not leave. */
  async activate(version: number): Promise<boolean> {
    const target = this.target;
    const result = buildActivateCommand(version);
    if (target === null || !result.valid) {
      return false;
    }
    const record = await this.record.send(
      target.key,
      { kind: "activate", version },
      result.command,
    );
    return record !== null;
  }
}

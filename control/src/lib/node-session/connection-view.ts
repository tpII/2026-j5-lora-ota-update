/**
 * A connection as the views and the pure rules see it: an immutable snapshot of its status and of
 * the state of its node, and the one rule that tells when two connections reach the same node.
 * NodeDirectory (state/node-directory.svelte.ts) publishes one per connection.
 */
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import type { TransportKind } from "$lib/transports/console-transport.ts";
import type { ConnectionStatus } from "./node-connection.ts";
import type { NodeState } from "./node-state.ts";

export interface ConnectionView {
  readonly key: string;
  readonly transportKind: TransportKind;
  readonly transportDescription: string;
  readonly status: ConnectionStatus;
  readonly closureMessage: string | null;
  readonly state: NodeState;
  /** Another connection reaches the same node, so its lines arrive twice. */
  readonly duplicated: boolean;
}

/** A connection whose node takes commands: open, and the node told its identifier. */
export type IdentifiedConnection = ConnectionView & {
  readonly status: "open";
  readonly state: NodeState & { readonly identifier: NodeIdentifier };
};

export function isIdentified(connection: ConnectionView): connection is IdentifiedConnection {
  return connection.status === "open" && connection.state.identifier !== null;
}

/** What the same-node rule looks at, in a NodeConnection and in a ConnectionView alike. */
interface NodeReach {
  readonly status: ConnectionStatus;
  readonly state: { readonly identifier: NodeIdentifier | null };
}

/**
 * True when `other` is another connection that still reaches the node of `connection`. A
 * connection reaches its node until it is closed: one that is closing can still deliver the lines
 * the node wrote before the transport ended, and one that is opening has no identifier yet.
 */
export function reachesSameNode(connection: NodeReach, other: NodeReach): boolean {
  return (
    other !== connection &&
    other.status !== "closed" &&
    connection.state.identifier !== null &&
    other.state.identifier === connection.state.identifier
  );
}

/**
 * The destination of a form in which one node asks a neighbor for echoes: the echo form and the
 * sender form of the communication test. It follows the node that requests, and other components
 * may fill it in, as the neighbor table does.
 */
import { untrack } from "svelte";
import { normalizeNodeIdentifier } from "$lib/commands/console-command.ts";
import type { NodeIdentifier } from "$lib/console/console-event.ts";

export class DestinationChoice {
  /** The destination as the operator types it. */
  text = $state("");
  /** Increases every time another component fills in the destination for the operator. */
  preparations = $state(0);
  /** Connection of the node the destination was last checked against. */
  #requesterKey: string | null = null;

  /** Fills in `identifier` and asks the form to bring its destination into view. */
  prepare(identifier: NodeIdentifier): void {
    this.text = identifier;
    this.preparations += 1;
  }

  /**
   * Follows the node that requests the echoes, through its connection `requesterKey`, and its
   * `neighbors`. When the node changes, a destination that is not one of its neighbors gives way
   * to the first neighbor; while it stays, an empty destination takes the first neighbor as soon
   * as there is one. Returns true when it replaced the destination. Without a node, nothing
   * changes.
   */
  follow(requesterKey: string | null, neighbors: readonly NodeIdentifier[]): boolean {
    if (requesterKey === null) {
      return false;
    }
    const text = untrack(() => this.text);
    let next = text;
    if (requesterKey !== this.#requesterKey) {
      this.#requesterKey = requesterKey;
      if (!neighbors.includes(normalizeNodeIdentifier(text))) {
        next = neighbors[0] ?? "";
      }
    } else if (text === "") {
      next = neighbors[0] ?? "";
    }
    if (next === text) {
      return false;
    }
    this.text = next;
    return true;
  }
}

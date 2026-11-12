/**
 * Which events tell the active or the available version of a node. The node state applies them to
 * the node whose console emitted them (node-update-state.ts); the update metrics apply them to
 * every node they name, the neighbors of a HELLO or `neighbor` event included
 * (update/update-metrics.ts).
 */
import type { ConsoleEvent, NodeIdentifier } from "$lib/console/console-event.ts";
import { neighborLastHeardHostTime } from "./neighbor-table.ts";

/** The versions an event tells; a version it does not tell is absent. */
export interface AnnouncedVersions {
  readonly active?: number;
  readonly available?: number;
}

export interface VersionAnnouncement extends AnnouncedVersions {
  readonly id: NodeIdentifier;
  /**
   * Host time the information dates from: a `neighbor` entry is as old as the last packet its
   * observer heard from the node.
   */
  readonly hostTime: number;
}

/** What an event tells about the versions of the node whose console emitted it, or null. */
export function ownAnnouncedVersionsOf(event: ConsoleEvent): AnnouncedVersions | null {
  switch (event.ev) {
    case "boot":
      // Images live only in RAM: the node boots with version 0 and no image.
      return { active: 0, available: 0 };
    case "transfer":
      return { active: event.active, available: event.available };
    case "image":
      return { available: event.version };
    case "activation":
    case "vm":
    case "program":
      return { active: event.version };
    default:
      return null;
  }
}

/**
 * What an event, emitted by the console of `node` and received at `hostTime`, tells about the
 * versions of every node: its own, or those of the neighbor a HELLO or `neighbor` event describes.
 */
export function versionAnnouncementsOf(
  node: NodeIdentifier,
  event: ConsoleEvent,
  hostTime: number,
): VersionAnnouncement[] {
  if (event.ev === "hello" || event.ev === "neighbor") {
    return [
      {
        id: event.ev === "hello" ? event.src : event.id,
        hostTime: neighborLastHeardHostTime(event, hostTime),
        active: event.version,
        available: event.available,
      },
    ];
  }
  const versions = ownAnnouncedVersionsOf(event);
  return versions === null ? [] : [{ id: node, hostTime, ...versions }];
}

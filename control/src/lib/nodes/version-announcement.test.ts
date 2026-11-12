import { describe, expect, it } from "vite-plus/test";
import type { ConsoleEventName, ConsoleEventOf } from "$lib/console/console-event.ts";
import {
  NODE_SESSION_LOG,
  UPDATE_RECEIVER_LOG,
  readFixtureEvents,
} from "$lib/testing/console-fixtures.ts";
import { ownAnnouncedVersionsOf, versionAnnouncementsOf } from "./version-announcement.ts";

const HOST_TIME = 1_759_840_000_000;

function eventOf<Name extends ConsoleEventName>(log: string, name: Name): ConsoleEventOf<Name> {
  const found = readFixtureEvents(log, 0)
    .map(({ event }) => event)
    .find((event): event is ConsoleEventOf<Name> => event.ev === name);
  if (found === undefined) {
    throw new Error(`no ${name} event in the fixture`);
  }
  return found;
}

describe("versionAnnouncementsOf", () => {
  it("tells the versions of the node from its own console", () => {
    expect(versionAnnouncementsOf("3A7F", eventOf(UPDATE_RECEIVER_LOG, "boot"), HOST_TIME)).toEqual(
      [{ id: "3A7F", hostTime: HOST_TIME, active: 0, available: 0 }],
    );
    const image = eventOf(UPDATE_RECEIVER_LOG, "image");
    expect(versionAnnouncementsOf("3A7F", image, HOST_TIME)).toEqual([
      { id: "3A7F", hostTime: HOST_TIME, available: image.version },
    ]);
    const program = eventOf(UPDATE_RECEIVER_LOG, "program");
    expect(versionAnnouncementsOf("3A7F", program, HOST_TIME)).toEqual([
      { id: "3A7F", hostTime: HOST_TIME, active: program.version },
    ]);
  });

  it("tells the versions of a neighbor as of the last packet heard from it", () => {
    expect(versionAnnouncementsOf("3A7F", eventOf(NODE_SESSION_LOG, "hello"), HOST_TIME)).toEqual([
      { id: "5C21", hostTime: HOST_TIME, active: 0, available: 0 },
    ]);
    // The `neighbor` entry of the fixture is 2063 ms old.
    expect(
      versionAnnouncementsOf("3A7F", eventOf(NODE_SESSION_LOG, "neighbor"), HOST_TIME),
    ).toEqual([{ id: "5C21", hostTime: HOST_TIME - 2063, active: 0, available: 0 }]);
  });

  it("tells nothing with the other events", () => {
    expect(versionAnnouncementsOf("3A7F", eventOf(NODE_SESSION_LOG, "radio"), HOST_TIME)).toEqual(
      [],
    );
    expect(ownAnnouncedVersionsOf(eventOf(NODE_SESSION_LOG, "hello"))).toBeNull();
  });
});

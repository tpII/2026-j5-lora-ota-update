import { describe, expect, it } from "vite-plus/test";
import { findShapeDeviations } from "./firmware-event-shapes.ts";
import {
  NODE_SESSION_LOG,
  RECEIVER_RUN_LOG,
  SENDER_RUN_LOG,
  UPDATE_ORIGIN_LOG,
  UPDATE_RECEIVER_LOG,
  splitFixtureLines,
} from "./console-fixtures.ts";

describe("hand-written console sessions", () => {
  it("write every event with the fields the firmware writes", () => {
    const sessions = [
      NODE_SESSION_LOG,
      SENDER_RUN_LOG,
      RECEIVER_RUN_LOG,
      UPDATE_ORIGIN_LOG,
      UPDATE_RECEIVER_LOG,
    ];
    const deviations = findShapeDeviations(sessions.flatMap(splitFixtureLines));
    expect(deviations).toEqual([]);
  });
});

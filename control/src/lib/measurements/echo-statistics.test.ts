import { describe, expect, it } from "vite-plus/test";
import { summarizeEchoResults } from "./echo-statistics.ts";
import { NODE_SESSION_LOG, readFixtureEvents } from "$lib/testing/console-fixtures.ts";
import { INITIAL_NODE_STATE, applyConsoleEvent, type EchoResult } from "$lib/nodes/node-state.ts";

describe("summarizeEchoResults", () => {
  it("counts answers and losses of the recorded session", () => {
    const state = readFixtureEvents(NODE_SESSION_LOG, 0).reduce(
      (current, { event, hostTime }) => applyConsoleEvent(current, event, hostTime),
      INITIAL_NODE_STATE,
    );
    expect(summarizeEchoResults(state.echoResults)).toEqual([
      {
        destination: "5C21",
        requested: 2,
        answered: 1,
        lost: 1,
        meanRoundTrip: 41237,
        minimumRoundTrip: 41237,
        maximumRoundTrip: 41237,
      },
    ]);
  });

  it("separates destinations and averages the round trips", () => {
    const answered = (destination: string, roundTripMicroseconds: number): EchoResult => ({
      outcome: "answered",
      hostTime: 0,
      destination,
      number: 1,
      size: 16,
      roundTripMicroseconds,
      rssi: -40,
      snr: 9,
      remoteRssi: -41,
      remoteSnr: 8,
    });
    const statistics = summarizeEchoResults([
      answered("9B04", 50_000),
      answered("5C21", 40_000),
      answered("5C21", 44_000),
    ]);
    expect(statistics.map((item) => [item.destination, item.answered, item.meanRoundTrip])).toEqual(
      [
        ["5C21", 2, 42_000],
        ["9B04", 1, 50_000],
      ],
    );
    expect(summarizeEchoResults([])).toEqual([]);
  });
});

import { describe, expect, it } from "vite-plus/test";
import type { ConsoleEvent } from "$lib/console/console-event.ts";
import { parseConsoleLine } from "$lib/console/console-line-parser.ts";
import { EchoSeries, type EchoSeriesOptions } from "./echo-series.ts";
import type { NodePort } from "$lib/nodes/node-port.ts";
import {
  DEFAULT_RADIO_SETTINGS,
  echoLossDeadlineMilliseconds,
} from "$lib/protocol/protocol-contract.ts";
import { timeOnAirOfPayload } from "$lib/radio/time-on-air.ts";
import { ManualTimeSource, flushAsyncWork } from "$lib/testing/manual-time-source.ts";

type Answer = "answered" | "lost" | "busy" | "usage" | "silent" | "unsent";

/** A node that answers each `echo` command with the next scripted outcome, as console lines. */
class EchoRequester implements NodePort {
  readonly identifier = "3A7F";
  readonly commands: string[] = [];
  /** Host time of each command. */
  readonly commandTimes: number[] = [];
  readonly #clock: ManualTimeSource;
  readonly #answers: Answer[];
  readonly #listeners = new Set<(event: ConsoleEvent, hostTime: number) => void>();
  #number = 0;

  constructor(answers: Answer[], clock = new ManualTimeSource(0)) {
    this.#answers = answers;
    this.#clock = clock;
  }

  sendCommand(command: string): Promise<void> {
    this.commands.push(command);
    this.commandTimes.push(this.#clock.now());
    if (this.#answers[0] === "unsent") {
      this.#answers.shift();
      return Promise.reject(new Error("El puerto se cerró."));
    }
    queueMicrotask(() => this.#answer(command));
    return Promise.resolve();
  }

  subscribe(listener: (event: ConsoleEvent, hostTime: number) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #answer(command: string): void {
    const [, destination, size = "16"] = command.split(" ");
    const answer = this.#answers.shift() ?? "answered";
    if (answer === "answered" || answer === "lost") {
      this.#number += 1;
    }
    const lines: Record<Answer, string | null> = {
      answered: `{"t":1,"ev":"echo","dst":"${destination}","n":${this.#number},"size":${size},"rtt":41237,"rssi":-38.5,"snr":10.25,"remote_rssi":-40.0,"remote_snr":9.75}`,
      lost: `{"t":1,"ev":"echo_lost","dst":"${destination}","n":${this.#number},"size":${size},"timeout":1036}`,
      busy: '{"t":1,"ev":"error","cmd":"echo","reason":"busy"}',
      usage:
        '{"t":1,"ev":"error","cmd":"echo","reason":"usage","detail":"echo <id> [size] with the id of another node"}',
      silent: null,
      unsent: null,
    };
    const line = lines[answer];
    const parsed = line === null ? null : parseConsoleLine(line);
    if (parsed?.kind === "event") {
      for (const listener of this.#listeners) {
        listener(parsed.event, this.#clock.now());
      }
    }
  }
}

function createSeries(
  answers: Answer[],
  options: Omit<EchoSeriesOptions, "node" | "timeSource" | "radio">,
  radio: EchoSeriesOptions["radio"] = DEFAULT_RADIO_SETTINGS,
) {
  const clock = new ManualTimeSource(0);
  const node = new EchoRequester(answers, clock);
  const series = new EchoSeries({ node, radio, timeSource: clock, ...options });
  return { clock, node, series };
}

/** Time the series waited between the first request and the second one. */
function firstWait(node: EchoRequester): number {
  return node.commandTimes[1]! - node.commandTimes[0]!;
}

describe("EchoSeries", () => {
  it("requests the echoes one after another and keeps what the node reported", async () => {
    const { clock, node, series } = createSeries([], { destination: "5c21", size: 32, count: 5 });
    const snapshot = await clock.advanceUntilSettled(series.run());
    expect(snapshot).toMatchObject({
      status: "finished",
      destination: "5C21",
      requested: 5,
      answered: 5,
      lost: 0,
      total: 5,
      failure: null,
    });
    expect(snapshot.results.map((result) => [result.outcome, result.number])).toEqual([
      ["answered", 1],
      ["answered", 2],
      ["answered", 3],
      ["answered", 4],
      ["answered", 5],
    ]);
    expect(snapshot.results[0]).toMatchObject({
      destination: "5C21",
      size: 32,
      roundTripMicroseconds: 41237,
      rssi: -38.5,
      remoteRssi: -40,
    });
    expect(node.commands).toEqual(Array.from({ length: 5 }, () => "echo 5C21 32"));
  });

  it("counts lost echoes, including a node that never reports a result", async () => {
    const { clock, node, series } = createSeries(["answered", "lost", "silent", "answered"], {
      destination: "5C21",
      count: 4,
      pauseMilliseconds: 0,
    });
    const snapshot = await clock.advanceUntilSettled(series.run());
    expect(snapshot).toMatchObject({ status: "finished", requested: 4, answered: 2, lost: 2 });
    // The request without any report leaves no record.
    expect(snapshot.results.map((result) => result.outcome)).toEqual([
      "answered",
      "lost",
      "answered",
    ]);
    expect(node.commands[0]).toBe("echo 5C21");
  });

  it("waits for a result as long as the loss deadline of the radio settings, plus a margin", async () => {
    const fast = createSeries(["silent"], { destination: "5C21", count: 2, pauseMilliseconds: 0 });
    await fast.clock.advanceUntilSettled(fast.series.run());
    expect(firstWait(fast.node)).toBeGreaterThan(
      echoLossDeadlineMilliseconds(timeOnAirOfPayload(16, DEFAULT_RADIO_SETTINGS)),
    );

    const slowRadio = { ...DEFAULT_RADIO_SETTINGS, sf: 12, bw: 125 } as const;
    const slow = createSeries(
      ["silent"],
      { destination: "5C21", size: 239, count: 2, pauseMilliseconds: 0 },
      slowRadio,
    );
    await slow.clock.advanceUntilSettled(slow.series.run());
    // No fixed wait fits every modulation: a long echo at SF12 and 125 kHz outlasts 10 s.
    expect(echoLossDeadlineMilliseconds(timeOnAirOfPayload(239, slowRadio))).toBeGreaterThan(
      10_000,
    );
    expect(firstWait(slow.node)).toBeGreaterThan(
      echoLossDeadlineMilliseconds(timeOnAirOfPayload(239, slowRadio)),
    );
    expect(firstWait(slow.node)).toBeGreaterThan(firstWait(fast.node));
  });

  it("repeats a request the node refused as busy", async () => {
    const { clock, node, series } = createSeries(["busy", "busy", "answered"], {
      destination: "5C21",
      count: 1,
    });
    const snapshot = await clock.advanceUntilSettled(series.run());
    expect(snapshot).toMatchObject({ status: "finished", requested: 1, answered: 1 });
    expect(node.commands).toHaveLength(3);
  });

  it("fails when the node refuses the request for another reason", async () => {
    const { clock, series } = createSeries(["usage"], { destination: "5C21", count: 3 });
    const snapshot = await clock.advanceUntilSettled(series.run());
    expect(snapshot).toMatchObject({
      status: "failed",
      requested: 0,
      failure:
        "El nodo 3A7F rechazó «echo 5C21» (usage: echo <id> [size] with the id of another node).",
    });
  });

  it("fails when the request cannot reach the node", async () => {
    const { clock, series } = createSeries(["answered", "unsent"], {
      destination: "5C21",
      count: 3,
      pauseMilliseconds: 0,
    });
    const snapshot = await clock.advanceUntilSettled(series.run());
    expect(snapshot).toMatchObject({
      status: "failed",
      requested: 1,
      failure: "No se pudo enviar «echo 5C21» al nodo 3A7F: El puerto se cerró.",
    });
  });

  it("refuses an invalid destination without sending anything", async () => {
    const { node, series } = createSeries([], { destination: "FFFF", count: 3 });
    const snapshot = await series.run();
    expect(snapshot.status).toBe("failed");
    expect(node.commands).toEqual([]);
  });

  it("stops during the pause between two echoes", async () => {
    const { series } = createSeries([], {
      destination: "5C21",
      count: 10,
      pauseMilliseconds: 5000,
    });
    const finished = series.run();
    await flushAsyncWork();
    series.stop();
    const snapshot = await finished;
    expect(snapshot).toMatchObject({ status: "stopped", requested: 1, answered: 1 });
  });

  it("stops while it waits to repeat a request the node refused as busy", async () => {
    const { node, series } = createSeries(["busy"], { destination: "5C21", count: 3 });
    const finished = series.run();
    await flushAsyncWork();
    series.stop();
    const snapshot = await finished;
    expect(snapshot).toMatchObject({ status: "stopped", requested: 0 });
    expect(node.commands).toHaveLength(1);
  });
});

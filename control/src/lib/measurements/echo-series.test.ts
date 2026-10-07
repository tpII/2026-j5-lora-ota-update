import { describe, expect, it } from "vite-plus/test";
import type { CampaignNode } from "./capacity-test-campaign.ts";
import type { ConsoleEvent } from "$lib/console/console-event.ts";
import { parseConsoleLine } from "$lib/console/console-line-parser.ts";
import { EchoSeries, type EchoSeriesSnapshot } from "./echo-series.ts";
import { ManualTimeSource } from "$lib/utils/time-source.ts";

type Answer = "answered" | "lost" | "busy" | "usage" | "silent";

/** A node that answers each `echo` command with the next scripted outcome, as console lines. */
class EchoRequester implements CampaignNode {
  readonly identifier = "3A7F";
  readonly commands: string[] = [];
  readonly #answers: Answer[];
  readonly #listeners = new Set<(event: ConsoleEvent, hostTime: number) => void>();
  #number = 0;

  constructor(answers: Answer[]) {
    this.#answers = answers;
  }

  sendCommand(command: string): Promise<void> {
    this.commands.push(command);
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
    };
    const line = lines[answer];
    const parsed = line === null ? null : parseConsoleLine(line);
    if (parsed?.kind === "event") {
      for (const listener of this.#listeners) {
        listener(parsed.event, 0);
      }
    }
  }
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function runToEnd(series: EchoSeries, clock: ManualTimeSource): Promise<EchoSeriesSnapshot> {
  let settled = false;
  const result = series.run().finally(() => {
    settled = true;
  });
  for (let step = 0; step < 1000 && !settled; step += 1) {
    await flushAsyncWork();
    if (!settled) {
      clock.advanceBy(100);
    }
  }
  return result;
}

describe("EchoSeries", () => {
  it("requests the echoes one after another", async () => {
    const clock = new ManualTimeSource(0);
    const node = new EchoRequester([]);
    const series = new EchoSeries({
      node,
      destination: "5c21",
      size: 32,
      count: 5,
      timeSource: clock,
    });
    const snapshot = await runToEnd(series, clock);
    expect(snapshot).toEqual({
      status: "finished",
      destination: "5C21",
      requested: 5,
      answered: 5,
      lost: 0,
      total: 5,
      failure: null,
    });
    expect(node.commands).toEqual(Array.from({ length: 5 }, () => "echo 5C21 32"));
  });

  it("counts lost echoes, including a node that never reports a result", async () => {
    const clock = new ManualTimeSource(0);
    const node = new EchoRequester(["answered", "lost", "silent", "answered"]);
    const series = new EchoSeries({
      node,
      destination: "5C21",
      count: 4,
      pauseMilliseconds: 0,
      timeSource: clock,
    });
    const snapshot = await runToEnd(series, clock);
    expect(snapshot).toMatchObject({ status: "finished", requested: 4, answered: 2, lost: 2 });
    expect(node.commands[0]).toBe("echo 5C21");
  });

  it("repeats a request the node refused as busy", async () => {
    const clock = new ManualTimeSource(0);
    const node = new EchoRequester(["busy", "busy", "answered"]);
    const series = new EchoSeries({ node, destination: "5C21", count: 1, timeSource: clock });
    const snapshot = await runToEnd(series, clock);
    expect(snapshot).toMatchObject({ status: "finished", requested: 1, answered: 1 });
    expect(node.commands).toHaveLength(3);
  });

  it("fails when the node refuses the request for another reason", async () => {
    const clock = new ManualTimeSource(0);
    const node = new EchoRequester(["usage"]);
    const snapshot = await runToEnd(
      new EchoSeries({ node, destination: "5C21", count: 3, timeSource: clock }),
      clock,
    );
    expect(snapshot).toMatchObject({
      status: "failed",
      requested: 0,
      failure: "El nodo rechazó el eco (usage: echo <id> [size] with the id of another node).",
    });
  });

  it("refuses an invalid destination without sending anything", async () => {
    const node = new EchoRequester([]);
    const snapshot = await new EchoSeries({ node, destination: "FFFF", count: 3 }).run();
    expect(snapshot.status).toBe("failed");
    expect(node.commands).toEqual([]);
  });

  it("stops during the pause between two echoes", async () => {
    const clock = new ManualTimeSource(0);
    const node = new EchoRequester([]);
    const series = new EchoSeries({
      node,
      destination: "5C21",
      count: 10,
      pauseMilliseconds: 5000,
      timeSource: clock,
    });
    const finished = series.run();
    await flushAsyncWork();
    series.stop();
    const snapshot = await finished;
    expect(snapshot).toMatchObject({ status: "stopped", requested: 1, answered: 1 });
  });
});

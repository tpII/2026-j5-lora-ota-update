import { describe, expect, it } from "vite-plus/test";
import {
  CommunicationReceiver,
  HOLD_RENEWAL_INTERVAL_MILLISECONDS,
} from "./communication-receiver.ts";
import { buildServedEchoesCsv, summarizeServedEchoes } from "./communication-test-metrics.ts";
import { DEFAULT_RADIO_SETTINGS, type RadioSettings } from "$lib/radio/radio-settings.ts";
import { SimulatedNode, type SimulatedNodeBehavior } from "$lib/testing/simulated-node.ts";
import { ManualTimeSource } from "$lib/utils/time-source.ts";

const START_TIME = 1_759_850_000_000;
const RADIO: RadioSettings = { ...DEFAULT_RADIO_SETTINGS, chip: -9, lna: "bypass" };

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settle<Value>(promise: Promise<Value>, clock: ManualTimeSource): Promise<Value> {
  let settled = false;
  const result = promise.finally(() => {
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

function createReceiver(behavior: SimulatedNodeBehavior = {}) {
  const clock = new ManualTimeSource(START_TIME);
  const node = new SimulatedNode("3A7F", "V4.3", clock, behavior);
  const receiver = new CommunicationReceiver({
    node,
    radio: RADIO,
    modulation: { sf: 10, bw: 250, cr: 8 },
    timeSource: clock,
  });
  return { clock, node, receiver };
}

describe("CommunicationReceiver", () => {
  it("holds the HELLO and applies the modulation until it is deactivated", async () => {
    const { clock, node, receiver } = createReceiver();
    const active = await settle(receiver.activate(), clock);

    expect(active.status).toBe("active");
    expect(node.presenceHoldSeconds).toBe(3600);
    expect(node.modulation).toEqual({ sf: 10, bw: 250, cr: 8 });

    const inactive = await settle(receiver.deactivate(), clock);
    expect(inactive.status).toBe("inactive");
    expect(inactive.restored).toBe(true);
    expect(inactive.deactivationHostTime).not.toBeNull();
    expect(node.modulation).toEqual({ sf: 7, bw: 500, cr: 5 });
    expect(node.presenceHoldSeconds).toBeNull();
  });

  it("renews the hold while it stays active", async () => {
    const { clock, node, receiver } = createReceiver();
    await settle(receiver.activate(), clock);
    clock.advanceBy(HOLD_RENEWAL_INTERVAL_MILLISECONDS);
    await flushAsyncWork();

    expect(node.commands.filter((command) => command === "presence off 3600")).toHaveLength(2);
    expect(receiver.snapshot.failure).toBeNull();
    await settle(receiver.deactivate(), clock);
    clock.advanceBy(HOLD_RENEWAL_INTERVAL_MILLISECONDS);
    await flushAsyncWork();
    expect(node.commands.filter((command) => command === "presence off 3600")).toHaveLength(2);
  });

  it("puts the node back when the modulation is refused", async () => {
    const { clock, node, receiver } = createReceiver({
      radioRefusal: { reason: "busy", times: 1 },
    });
    const snapshot = await settle(receiver.activate(), clock);

    expect(snapshot.status).toBe("failed");
    expect(snapshot.failure).toContain("busy");
    expect(snapshot.restored).toBe(true);
    expect(node.presenceHoldSeconds).toBeNull();
    expect(node.commands).toEqual([
      "presence off 3600",
      "radio sf 10 bw 250 cr 8",
      "radio sf 7 bw 500 cr 5",
      "presence on",
    ]);
  });
});

describe("receiver metrics", () => {
  const echoes = [
    { source: "5C21", number: 1, size: 4, rssi: -60, snr: 7.5, hostTime: 10 },
    { source: "5C21", number: 2, size: 4, rssi: -62, snr: 8, hostTime: 20 },
    { source: "00F4", number: 1, size: 4, rssi: -90, snr: -3.25, hostTime: 30 },
  ];

  it("groups the echoes by sender", () => {
    const [first, second] = summarizeServedEchoes(echoes);
    expect(first).toMatchObject({ source: "5C21", served: 2, firstHostTime: 10, lastHostTime: 20 });
    expect(first?.rssi).toEqual({ average: -61, minimum: -62, maximum: -60 });
    expect(second).toMatchObject({ source: "00F4", served: 1 });
  });

  it("writes one row per echo answered", () => {
    expect(buildServedEchoesCsv(echoes)).toBe(
      "n,host_time,src,size,rssi,snr\n1,10,5C21,4,-60,7.5\n2,20,5C21,4,-62,8\n1,30,00F4,4,-90,-3.25\n",
    );
  });
});

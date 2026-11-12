import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_RADIO_SETTINGS } from "$lib/protocol/protocol-contract.ts";
import {
  CommunicationReceiver,
  HOLD_RENEWAL_INTERVAL_MILLISECONDS,
} from "./communication-receiver.ts";
import { type RadioSettings } from "$lib/radio/radio-settings.ts";
import { SimulatedNode, type SimulatedNodeBehavior } from "$lib/testing/simulated-node.ts";
import { ManualTimeSource, flushAsyncWork } from "$lib/testing/manual-time-source.ts";

const START_TIME = 1_759_850_000_000;
const RADIO: RadioSettings = { ...DEFAULT_RADIO_SETTINGS, chip: -9, lna: "bypass" };

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
    const active = await clock.advanceUntilSettled(receiver.activate());

    expect(active.status).toBe("active");
    expect(node.presenceHoldSeconds).toBe(3600);
    expect(node.modulation).toEqual({ sf: 10, bw: 250, cr: 8 });

    const inactive = await clock.advanceUntilSettled(receiver.deactivate());
    expect(inactive.status).toBe("inactive");
    expect(inactive.restored).toBe(true);
    expect(inactive.deactivationHostTime).not.toBeNull();
    expect(node.modulation).toEqual({ sf: 7, bw: 500, cr: 5 });
    expect(node.presenceHoldSeconds).toBeNull();
  });

  it("renews the hold while it stays active", async () => {
    const { clock, node, receiver } = createReceiver();
    await clock.advanceUntilSettled(receiver.activate());
    clock.advanceBy(HOLD_RENEWAL_INTERVAL_MILLISECONDS);
    await flushAsyncWork();

    expect(node.commands.filter((command) => command === "presence off 3600")).toHaveLength(2);
    expect(receiver.snapshot.failure).toBeNull();
    await clock.advanceUntilSettled(receiver.deactivate());
    clock.advanceBy(HOLD_RENEWAL_INTERVAL_MILLISECONDS);
    await flushAsyncWork();
    expect(node.commands.filter((command) => command === "presence off 3600")).toHaveLength(2);
  });

  it("puts the node back when the modulation is refused", async () => {
    const { clock, node, receiver } = createReceiver({
      radioRefusal: { reason: "radio_failure", times: 1 },
    });
    const snapshot = await clock.advanceUntilSettled(receiver.activate());

    expect(snapshot.status).toBe("failed");
    expect(snapshot.failure).toBe(
      "No se pudo aplicar la modulación de la prueba: el nodo 3A7F rechazó «radio sf 10 bw 250 cr 8» (radio_failure).",
    );
    expect(snapshot.restored).toBe(true);
    expect(node.presenceHoldSeconds).toBeNull();
    expect(node.commands).toEqual([
      "presence off 3600",
      "radio sf 10 bw 250 cr 8",
      "radio sf 7 bw 500 cr 5",
      "presence on",
    ]);
  });

  it("applies the modulation again while the node refuses it as busy", async () => {
    const { clock, node, receiver } = createReceiver({
      radioRefusal: { reason: "busy", times: 1 },
    });
    const snapshot = await clock.advanceUntilSettled(receiver.activate());

    expect(snapshot.status).toBe("active");
    expect(node.modulation).toEqual({ sf: 10, bw: 250, cr: 8 });
    expect(node.commands).toEqual([
      "presence off 3600",
      "radio sf 10 bw 250 cr 8",
      "radio sf 10 bw 250 cr 8",
    ]);
  });
});

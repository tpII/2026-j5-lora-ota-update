import { describe, expect, it } from "vite-plus/test";
import { parseHex } from "$lib/utils/hex.ts";
import { DEFAULT_CAPACITY_TEST_CONFIGURATION } from "$lib/measurements/capacity-test-plan.ts";
import type { ExportFolder } from "$lib/measurements/measurement-export.ts";
import { DEFAULT_COMMUNICATION_TEST_CONFIGURATION } from "$lib/measurements/communication-test.ts";
import { ManualTimeSource, flushAsyncWork } from "$lib/testing/manual-time-source.ts";
import { SimulatedConsoleTransport } from "$lib/testing/simulated-console-transport.ts";
import {
  SimulatedNode,
  createSimulatedPair,
  type SimulatedNodeBehavior,
} from "$lib/testing/simulated-node.ts";
import defaultOperatorKeyPem from "../../../../firmware/protocol/default_operator_key.pem?raw";
import signedImageVector from "../../../../firmware/protocol/test-vectors/signed-image.json";
import {
  ControlPanel,
  REFRESH_INTERVAL_MILLISECONDS,
  type ControlPanelOptions,
} from "./control-panel.svelte.ts";

async function advance(clock: ManualTimeSource, milliseconds: number): Promise<void> {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += REFRESH_INTERVAL_MILLISECONDS) {
    await flushAsyncWork();
    clock.advanceBy(Math.min(REFRESH_INTERVAL_MILLISECONDS, milliseconds - elapsed));
  }
  await flushAsyncWork();
}

/** A panel with nodes 5C21 (usb-1) and 3A7F (usb-2) connected and identified. */
async function connectedPanel(
  senderBehavior: SimulatedNodeBehavior = {},
  receiverBehavior: SimulatedNodeBehavior = {},
  options: Omit<ControlPanelOptions, "timeSource"> = {},
): Promise<{
  panel: ControlPanel;
  clock: ManualTimeSource;
  sender: SimulatedNode;
  receiver: SimulatedNode;
}> {
  const clock = new ManualTimeSource(1_800_000_000_000);
  const panel = new ControlPanel({ ...options, timeSource: clock });
  const { sender, receiver } = createSimulatedPair(clock, senderBehavior, receiverBehavior);
  await panel.connect(new SimulatedConsoleTransport(sender));
  await panel.connect(new SimulatedConsoleTransport(receiver));
  await advance(clock, REFRESH_INTERVAL_MILLISECONDS);
  return { panel, clock, sender, receiver };
}

function errorNotices(panel: ControlPanel): string[] {
  return panel.notices.filter((notice) => notice.level === "error").map((notice) => notice.text);
}

describe("ControlPanel", () => {
  it("identifies the nodes it connects and chooses the last one", async () => {
    const { panel } = await connectedPanel();
    expect(panel.nodes.identified.map((connection) => connection.state.identifier)).toEqual([
      "5C21",
      "3A7F",
    ]);
    expect(panel.nodes.selectedIdentified?.key).toBe("usb-2");
    expect(panel.connectionGraph.nodes.map((node) => node.id)).toEqual(["3A7F", "5C21"]);
  });

  it("refuses a capacity test while an echo series runs, and the reverse", async () => {
    const { panel, clock, receiver } = await connectedPanel({ ignoresRadio: true });

    panel.startEchoSeries("usb-2", "5C21", 16, 100);
    await flushAsyncWork();
    expect(panel.echoSeries.isActive).toBe(true);
    expect(panel.hasActiveTest).toBe(true);
    panel.startCampaign(DEFAULT_CAPACITY_TEST_CONFIGURATION, "usb-1", "usb-2");
    expect(panel.campaign.snapshot).toBeNull();
    expect(errorNotices(panel)).toEqual([
      "Hay una serie de ecos en curso: hay que esperar a que termine.",
    ]);

    panel.stopEchoSeries();
    await advance(clock, 5000);
    expect(panel.echoSeries.isActive).toBe(false);

    // The sender ignores `radio`, so the campaign waits for its confirmation.
    panel.startCampaign(DEFAULT_CAPACITY_TEST_CONFIGURATION, "usb-1", "usb-2");
    await flushAsyncWork();
    expect(panel.campaign.isActive).toBe(true);
    const commandsBefore = receiver.commands.length;
    panel.startEchoSeries("usb-2", "5C21", 16, 1);
    expect(panel.echoSeries.snapshot?.total).toBe(100);
    expect(panel.testTarget("capacity-test")).toMatchObject({
      pinned: true,
      connection: { key: "usb-1" },
    });
    expect(panel.testTarget()).toMatchObject({ pinned: false, connection: { key: "usb-2" } });
    panel.stopCampaign();
    await advance(clock, 10_000);
    expect(panel.campaign.isActive).toBe(false);
    expect(
      receiver.commands.slice(commandsBefore).some((command) => command.startsWith("echo")),
    ).toBe(false);
  });

  it("leaves the radio of a test node to the test and frees the other nodes", async () => {
    const { panel, sender, receiver } = await connectedPanel();
    panel.activateReceiverMode("usb-2", { sf: 9, bw: 500, cr: 5 });
    await flushAsyncWork();
    expect(panel.receiverMode.isActive).toBe(true);
    expect(panel.refusal("radio-settings", "usb-2")).toMatchObject({ activity: "receiver-mode" });
    expect(panel.refusal("radio-settings", "usb-1")).toBeNull();

    const before = receiver.commands.length;
    expect(await panel.changeRadioSettings("usb-2", "radio sf 7")).toBe(false);
    expect(receiver.commands.length).toBe(before);
    expect(errorNotices(panel)).toEqual([
      "El nodo está en modo receptor: sus parámetros de radio no se cambian hasta desactivarlo.",
    ]);
    expect(await panel.changeRadioSettings("usb-1", "radio sf 7")).toBe(true);
    expect(sender.commands.at(-1)).toBe("radio sf 7");

    expect(await panel.startManualRun("usb-1", "run 10 8 0")).toBe(false);
    panel.startCommunicationTest(DEFAULT_COMMUNICATION_TEST_CONFIGURATION, "usb-1", "3A7F");
    expect(panel.communicationTest.snapshot).toBeNull();
  });

  it("counts a run transmitted by hand as a test in progress", async () => {
    const { panel, clock } = await connectedPanel({ holdsRun: true });
    expect(await panel.startManualRun("usb-1", "run 10 8 0")).toBe(true);
    await advance(clock, REFRESH_INTERVAL_MILLISECONDS);
    expect(panel.activities).toEqual([{ kind: "manual-run", keys: ["usb-1"], nodes: ["5C21"] }]);
    expect(panel.refusal("manual-run", "usb-1")?.cause).toBe("activity");
    expect(panel.refusal("radio-settings", "usb-1")?.cause).toBe("busy");
    expect(panel.refusal("radio-settings", "usb-2")).toBeNull();
    expect(panel.refusal("echo-series", "usb-2")).toMatchObject({ activity: "manual-run" });
    expect(panel.hasActiveTest).toBe(true);
  });

  it("filters the event stream only while its section is visible", async () => {
    const { panel, clock } = await connectedPanel();
    expect(panel.stream.records.length).toBeGreaterThan(0);
    expect(panel.stream.matching).toEqual([]);

    panel.visibleSection = "events";
    expect(panel.stream.matching).toEqual(panel.stream.records);
    panel.stream.kindFilter = "command";
    expect(panel.stream.matching.every((record) => record.kind === "command")).toBe(true);
    panel.stream.nodeFilter = "selected";
    expect(panel.stream.matching.map((record) => record.connectionKey)).toEqual(["usb-2"]);
    panel.nodes.select("usb-1");
    expect(panel.stream.matching.map((record) => record.connectionKey)).toEqual(["usb-1"]);

    panel.visibleSection = "network";
    await advance(clock, REFRESH_INTERVAL_MILLISECONDS);
    expect(panel.stream.matching).toEqual([]);
  });

  it("marks a closed duplicate connection and keeps the node reachable through the other", async () => {
    const { panel, clock, sender } = await connectedPanel();
    const transport = new SimulatedConsoleTransport(sender, "websocket");
    await panel.connect(transport);
    await advance(clock, REFRESH_INTERVAL_MILLISECONDS);
    expect(panel.nodes.connections.map((connection) => connection.duplicated)).toEqual([
      true,
      false,
      true,
    ]);

    transport.lose();
    await advance(clock, REFRESH_INTERVAL_MILLISECONDS);
    expect(panel.nodes.connections.map((connection) => connection.duplicated)).toEqual([
      false,
      false,
      false,
    ]);
    expect(panel.nodes.byIdentifier("5C21")?.key).toBe("usb-1");
    expect(errorNotices(panel)).toEqual(["Se perdió la conexión."]);
  });

  it("records the version of each load_image it sends and how the node answered", async () => {
    const { panel, clock, receiver } = await connectedPanel();
    expect(await panel.update.session.importKey(defaultOperatorKeyPem, "default.pem")).toBeNull();
    const program = parseHex(signedImageVector.program)!;
    const version = 1_800_000_000;

    expect(await panel.update.loadImage(program, version)).toBeNull();
    expect(panel.update.lastLoadResponse).toEqual({ kind: "waiting" });
    await receiver.settle();
    await advance(clock, REFRESH_INTERVAL_MILLISECONDS);
    expect(panel.update.lastLoadResponse).toEqual({ kind: "accepted" });
    expect(panel.update.record.versions).toEqual([version]);
    expect(panel.update.session.nextVersion).toBeGreaterThan(version);

    expect(await panel.update.loadImage(program, version)).toBeNull();
    await receiver.settle();
    await advance(clock, REFRESH_INTERVAL_MILLISECONDS);
    expect(panel.update.lastLoadResponse).toMatchObject({
      kind: "rejected",
      error: { reason: "version_not_newer" },
    });
    expect(
      panel.update.record.commands.map((record) => [record.node, record.command, record.accepted]),
    ).toEqual([
      ["3A7F", { kind: "load_image", version }, true],
      ["3A7F", { kind: "load_image", version }, false],
    ]);
    expect(panel.update.record.versions).toEqual([version]);
  });

  it("measures every update loaded since the record was cleared, while the section is visible", async () => {
    const { panel, clock, receiver } = await connectedPanel();
    expect(await panel.update.session.importKey(defaultOperatorKeyPem, "default.pem")).toBeNull();
    const program = parseHex(signedImageVector.program)!;
    for (const version of [1_800_000_000, 1_800_000_100]) {
      expect(await panel.update.loadImage(program, version)).toBeNull();
      await receiver.settle();
      await advance(clock, 1000);
    }
    expect(panel.update.record.metrics).toEqual([]);

    panel.visibleSection = "update";
    const metrics = panel.update.record.metrics;
    expect(metrics.map((measured) => [measured.version, measured.origin])).toEqual([
      [1_800_000_000, "3A7F"],
      [1_800_000_100, "3A7F"],
    ]);
    await advance(clock, REFRESH_INTERVAL_MILLISECONDS);
    // Without new events or commands, the metrics are not computed again.
    expect(panel.update.record.metrics).toBe(metrics);
  });

  it("counts the update commands typed in the event stream", async () => {
    const { panel, receiver } = await connectedPanel();
    expect(await panel.sendTypedCommand("usb-2", "status")).toBe(true);
    expect(await panel.sendTypedCommand("usb-2", "activate 1800000000")).toBe(true);
    expect(receiver.commands.at(-1)).toBe("activate 1800000000");
    expect(panel.update.record.commands.map((record) => record.command)).toEqual([
      { kind: "activate", version: 1_800_000_000 },
    ]);
  });

  it("exports the nodes not excluded and keeps the outcome until the record is discarded", async () => {
    const folders: ExportFolder[] = [];
    const { panel, clock } = await connectedPanel(
      {},
      {},
      {
        writeExport: async (folder, localDate) => {
          folders.push(folder);
          return {
            method: "download",
            folderName: `${localDate}-${folder.test}-01`,
            parentName: null,
          };
        },
      },
    );
    panel.measurementSheet.setNodeIncluded("5C21", false);
    expect(panel.exportedNodes.map((node) => node.id)).toEqual(["3A7F"]);
    const description = panel.measurementSheet.description();

    const result = await panel.exports["power-sweep"].write(description);
    expect(result).toMatchObject({ kind: "written", outcome: { method: "download" } });
    expect(panel.exportResults.get("power-sweep")).toBe(result);
    expect(panel.exportResults.get("capacity-test")).toBeUndefined();
    const [folder] = folders;
    expect(folder?.test).toBe("power-sweep");
    expect(folder?.files.map((file) => file.name)).toEqual([
      "metadata.json",
      "events.jsonl",
      "summary.csv",
    ]);
    expect(JSON.parse(folder?.files[0]?.content ?? "{}")).toMatchObject({
      test: "power-sweep",
      nodes: [{ id: "3A7F", model: "V4.3" }],
    });

    panel.clearMeasurementRecord();
    await advance(clock, REFRESH_INTERVAL_MILLISECONDS);
    expect(panel.exportResults.size).toBe(0);
  });

  it("keeps the reason of a failed export next to its button", async () => {
    const { panel } = await connectedPanel(
      {},
      {},
      {
        writeExport: () => Promise.reject(new Error("No hay lugar en el disco.")),
      },
    );
    expect(
      await panel.exports["capacity-test"].write(panel.measurementSheet.description()),
    ).toEqual({
      kind: "failed",
      message: "No hay lugar en el disco.",
    });
    expect(panel.exportResults.get("capacity-test")?.kind).toBe("failed");
  });
});

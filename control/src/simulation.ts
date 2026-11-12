/**
 * Entry of the simulation build of the panel (simulation.html, vite.simulation.config.ts), which
 * tools/capture_control_panel_screenshots.sh serves to take the screenshots of the reports. It
 * replaces Web Serial and WebSocket with two simulated nodes on the system clock and then starts
 * the panel as src/main.ts does. The production build never includes this file.
 *
 * The network: D6D8, a V4.3 behind the serial port, and F604, a V2 behind the WebSocket, hear each
 * other. D6D8 also hears 9C41 and B013, two nodes the panel does not reach, and 9C41 hears E720.
 */
import type { BoardModel, NodeIdentifier } from "$lib/console/console-event.ts";
import {
  BROADCAST_IDENTIFIER,
  DEFAULT_RADIO_SETTINGS,
  FIRST_HELLO_MAXIMUM_DELAY_MILLISECONDS,
  HELLO_JITTER_MILLISECONDS,
  HELLO_PERIOD_MILLISECONDS,
} from "$lib/protocol/protocol-contract.ts";
import { installSimulatedConsoleAccess } from "$lib/testing/simulated-console-access.ts";
import {
  SimulatedNetwork,
  SimulatedNode,
  type AnnouncedState,
  type HelloNeighborEntry,
  type LinkQuality,
  type SimulatedFrame,
} from "$lib/testing/simulated-node.ts";
import { SYSTEM_TIME_SOURCE } from "$lib/utils/time-source.ts";

/** The nodes booted this long before the page opened. */
const UPTIME_AT_START_MILLISECONDS = 180_000;

/** Spread of the link quality around its level, as two boards on a table show it. */
const RSSI_SPREAD_DB = 3;
const SNR_SPREAD_DB = 1;
const FREQUENCY_ERROR_RANGE_HZ = { minimum: -190, maximum: -130 } as const;

/** Every how many echo requests F604 does not hear one. */
const ECHO_LOSS_PERIOD = 23;

/** Packets of a run that F604 does not hear. */
const LOST_TEST_PACKETS: readonly number[] = [137, 251];

/** RSSI and SNR at which a node hears each other node. */
type HearingLevels = Readonly<
  Record<NodeIdentifier, { readonly rssi: number; readonly snr: number }>
>;

function spread(level: number, width: number): number {
  return Math.round((level + (Math.random() - 0.5) * width) * 100) / 100;
}

function hearingOf(levels: HearingLevels): (frame: SimulatedFrame) => LinkQuality {
  return (frame) => {
    const level = levels[frame.source] ?? { rssi: -100, snr: -5 };
    return {
      rssi: spread(level.rssi, RSSI_SPREAD_DB),
      snr: spread(level.snr, SNR_SPREAD_DB),
      frequencyError:
        FREQUENCY_ERROR_RANGE_HZ.minimum +
        Math.random() * (FREQUENCY_ERROR_RANGE_HZ.maximum - FREQUENCY_ERROR_RANGE_HZ.minimum),
    };
  };
}

/** A node the panel does not reach, known only by the HELLO messages D6D8 hears from it. */
interface RemoteNode {
  readonly id: NodeIdentifier;
  readonly model: BoardModel;
  readonly epoch: number;
  readonly announced: Omit<AnnouncedState, "model" | "transmitted">;
  readonly neighbors: readonly HelloNeighborEntry[];
}

const REMOTE_NODES: readonly RemoteNode[] = [
  {
    id: "9C41",
    model: "V2",
    epoch: 3,
    announced: { version: 1762300800, available: 1762390000, vmFault: null, vmFailing: false },
    neighbors: [
      { id: "D6D8", rssi: -95, snr: -3.5 },
      { id: "E720", rssi: -88, snr: 1.25 },
    ],
  },
  {
    id: "B013",
    model: "V4.3",
    epoch: 3,
    announced: {
      version: 1762300800,
      available: 1762300800,
      vmFault: "division_by_zero",
      vmFailing: true,
    },
    neighbors: [{ id: "D6D8", rssi: -81, snr: 3 }],
  },
];

/** Packets the remote nodes had sent when the page opened. */
const REMOTE_TRANSMITTED_AT_START = 40;

const bootHostTime = SYSTEM_TIME_SOURCE.now() - UPTIME_AT_START_MILLISECONDS;
const network = new SimulatedNetwork(SYSTEM_TIME_SOURCE);
const serialNode = new SimulatedNode(
  "D6D8",
  "V4.3",
  SYSTEM_TIME_SOURCE,
  {
    epoch: 7,
    bootHostTime,
    freeHeap: 248_312,
    wireless: { enabled: true, clients: 0 },
    hearing: hearingOf({
      F604: { rssi: -61, snr: 9.5 },
      "9C41": { rssi: -97, snr: -4.25 },
      B013: { rssi: -79, snr: 3.5 },
    }),
  },
  network,
);
const websocketNode = new SimulatedNode(
  "F604",
  "V2",
  SYSTEM_TIME_SOURCE,
  {
    epoch: 12,
    bootHostTime,
    freeHeap: 201_456,
    wireless: { enabled: true, clients: 1 },
    hearing: hearingOf({ D6D8: { rssi: -64, snr: 8.75 } }),
    losesEchoRequest: (number) => number % ECHO_LOSS_PERIOD === 0,
    losesPacket: (_run, index) => LOST_TEST_PACKETS.includes(index),
  },
  network,
);
serialNode.start();
websocketNode.start();

REMOTE_NODES.forEach((remote, position) => {
  let sequence = 0;
  const announce = (): void => {
    sequence += 1;
    serialNode.receiveFrame({
      source: remote.id,
      epoch: remote.epoch,
      sequence,
      destination: BROADCAST_IDENTIFIER,
      channel: DEFAULT_RADIO_SETTINGS,
      body: {
        type: "hello",
        announced: {
          ...remote.announced,
          model: remote.model,
          transmitted: REMOTE_TRANSMITTED_AT_START + sequence - 1,
        },
        neighbors: remote.neighbors,
      },
    });
    SYSTEM_TIME_SOURCE.schedule(
      announce,
      HELLO_PERIOD_MILLISECONDS + (2 * Math.random() - 1) * HELLO_JITTER_MILLISECONDS,
    );
  };
  SYSTEM_TIME_SOURCE.schedule(announce, FIRST_HELLO_MAXIMUM_DELAY_MILLISECONDS * (position + 1));
});

installSimulatedConsoleAccess(serialNode, websocketNode);

await import("./main.ts");

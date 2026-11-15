/**
 * A node simulated for the tests and for the simulation build of the panel (src/simulation.ts):
 * it answers console commands with the lines the firmware writes (docs/protocol/console.md, with
 * the command table of the contract, CONSOLE_COMMANDS) and exchanges HELLO, ECHO, TEST,
 * FRAGMENT and REPORT frames with the other nodes of its SimulatedNetwork. Each frame takes its
 * time on air on the TimeSource of the network: a ManualTimeSource in the tests, the system clock
 * in the simulation build.
 *
 * Simplifications against the firmware: a frame reaches every node of the network on the same
 * frequency and modulation, with the link quality that the behavior of the receiver gives; a
 * receiver checks the format and the program of an image it completes over the radio but not its
 * signature, since the network carries the verified bytes of its sender; and the detail of an
 * image rejected for its format is only "format".
 */
import type {
  ActivationCause,
  BoardModel,
  BurstCause,
  ConsoleEvent,
  KnownErrorReason as ErrorReason,
  LnaMode,
  NodeIdentifier,
  TransmissionType,
} from "$lib/console/console-event.ts";
import {
  commandWordsOf,
  findConsoleCommand,
  lineCapacityOf,
  type ConsoleCommandAction,
  type ConsoleCommandDefinition,
  type ConsoleCommandForm,
} from "$lib/console/console-command-table.ts";
import { parseConsoleLine } from "$lib/console/console-line-parser.ts";
import { decodeImage, readImageVersion } from "$lib/image/image-format.ts";
import { formatHex, parseHex } from "$lib/utils/hex.ts";
import { DEFAULT_OPERATOR_PUBLIC_KEY } from "$lib/image/image-signing.ts";
import type { NodePort } from "$lib/nodes/node-port.ts";
import {
  ACCESS_POINT_NAME_PREFIX,
  BANDWIDTHS_KILOHERTZ,
  BROADCAST_IDENTIFIER,
  COMMAND_PRECONDITIONS,
  CONSOLE_COMMANDS,
  DEFAULT_ECHO_SIZE,
  DEFAULT_FRAGMENT_SIZE,
  DEFAULT_LNA_MODE,
  DEFAULT_RADIO_SETTINGS,
  ERROR_COMMAND_WORD_LENGTH,
  FIRST_HELLO_MAXIMUM_DELAY_MILLISECONDS,
  FIRST_HELLO_MINIMUM_DELAY_MILLISECONDS,
  FRAGMENT_HEADER_SIZE,
  FRONT_END_GAIN_STEPS,
  FREQUENCY_DECIMALS,
  IMAGE_FORMAT_DEFECTS,
  HELLO_FIXED_SIZE,
  HELLO_JITTER_MILLISECONDS,
  HELLO_NEIGHBOR_SIZE,
  HELLO_PERIOD_MILLISECONDS,
  LNA_MODES,
  LOW_NOISE_AMPLIFIER_BOARD_MODELS,
  MAXIMUM_CODING_RATE_DENOMINATOR,
  MAXIMUM_ECHO_SIZE,
  MAXIMUM_FRAGMENT_SIZE,
  MAXIMUM_FREQUENCY_MEGAHERTZ,
  MAXIMUM_IMAGE_SIZE,
  MAXIMUM_IMAGE_VERSION,
  MAXIMUM_NEIGHBORS,
  MAXIMUM_PREAMBLE_LENGTH,
  MAXIMUM_PRESENCE_HOLD_SECONDS,
  MAXIMUM_RUN_COUNT,
  MAXIMUM_RUN_INTERVAL_MILLISECONDS,
  MAXIMUM_SPREADING_FACTOR,
  MAXIMUM_SYNC_WORD,
  MAXIMUM_TEST_SIZE,
  MINIMUM_CODING_RATE_DENOMINATOR,
  MINIMUM_ECHO_SIZE,
  MINIMUM_FRAGMENT_SIZE,
  MINIMUM_FREQUENCY_MEGAHERTZ,
  MINIMUM_PREAMBLE_LENGTH,
  MINIMUM_PRESENCE_HOLD_SECONDS,
  MINIMUM_RUN_COUNT,
  MINIMUM_RUN_INTERVAL_MILLISECONDS,
  MINIMUM_SPREADING_FACTOR,
  MINIMUM_SYNC_WORD,
  MINIMUM_TEST_SIZE,
  NODE_ID_HEXADECIMAL_DIGITS,
  NO_NODE_IDENTIFIER,
  PACKET_DELIVERY_RATIO_DECIMALS,
  REGISTER_VALUE_DETAIL,
  REPORT_FIXED_SIZE,
  RSSI_DECIMALS,
  SNR_DECIMALS,
  TRANSFER_MARGIN_MILLISECONDS,
  TRANSMIT_POWER_RANGES,
  VM_INSTRUCTIONS_PER_POLL,
  VM_MINIMUM_PRINT_INTERVAL_MILLISECONDS,
  VM_RESTART_DELAY_MILLISECONDS,
  echoLossDeadlineMilliseconds,
  isNeighborExpired,
  runReceptionDeadlineMilliseconds,
} from "$lib/protocol/protocol-contract.ts";
import {
  FREQUENCY_AND_MODULATION_FIELDS,
  hasLowNoiseAmplifier,
  isTransmitPowerReachable,
  settingsMatch,
  type RadioSettings,
} from "$lib/radio/radio-settings.ts";
import { computeFrameLength, computeTimeOnAirMicroseconds } from "$lib/radio/time-on-air.ts";
import { type TimeSource } from "$lib/utils/time-source.ts";
import { formatPrintLine } from "$lib/vm/instruction-set.ts";
import { SimulatedPinBank } from "$lib/vm/simulated-pins.ts";
import { VirtualMachine, advance, type VmFault } from "$lib/vm/virtual-machine.ts";
import { verifyImage } from "./image-verification.ts";
import { ManualTimeSource } from "./manual-time-source.ts";

/** The settings a node holds; the transceiver setting follows from the power and the board. */
type NodeRadioSettings = Omit<RadioSettings, "chip">;

/** How a node hears one frame. */
export interface LinkQuality {
  readonly rssi: number;
  readonly snr: number;
  /** Frequency error of the reception, in Hz. */
  readonly frequencyError: number;
}

export interface SimulatedNodeBehavior {
  /** Epoch of the node; 1 by default. */
  readonly epoch?: number;
  /** Host time at which the node booted; one second before it is created by default. */
  readonly bootHostTime?: number;
  /** Free heap that `status` reports, in bytes. */
  readonly freeHeap?: number;
  /** State of the access point at boot: off by default. */
  readonly wireless?: { readonly enabled: boolean; readonly clients: number };
  /** How this node hears `frame`; fixed values per kind of frame by default. */
  readonly hearing?: (frame: SimulatedFrame) => LinkQuality;
  /** Packets of a run this node, as receiver, does not hear. */
  readonly losesPacket?: (run: number, index: number) => boolean;
  /** Refuses the next `radio` commands with this reason. */
  readonly radioRefusal?: { readonly reason: ErrorReason; readonly times: number };
  /** Never answers `radio` with arguments. */
  readonly ignoresRadio?: boolean;
  /** As receiver, closes its runs without reporting `run_end`. */
  readonly omitsRunEnd?: boolean;
  /** As sender, announces each run and transmits none of its packets until `run stop`. */
  readonly holdsRun?: boolean;
  /** Echo requests from another node that this node does not hear. */
  readonly losesEchoRequest?: (number: number) => boolean;
  /** Refuses `presence` with this reason. */
  readonly presenceRefusal?: ErrorReason;
  /**
   * Fragments from another node that this node does not hear; `delivery` counts, from 1, the
   * times that fragment index of that version reached the node.
   */
  readonly losesFragment?: (version: number, index: number, delivery: number) => boolean;
  /** Public key the node verifies images with; the default pair by default. */
  readonly operatorPublicKey?: string;
}

/** What a HELLO announces about its sender (docs/protocol/frame.md). */
export interface AnnouncedState {
  readonly model: BoardModel | null;
  readonly version: number;
  readonly available: number;
  readonly vmFault: VmFault | null;
  readonly vmFailing: boolean;
  readonly transmitted: number;
}

export interface HelloNeighborEntry {
  readonly id: NodeIdentifier;
  /** RSSI in whole dBm and SNR in quarters of a dB, as the HELLO body carries them. */
  readonly rssi: number;
  readonly snr: number;
}

/** The body of a frame, decoded. */
export type SimulatedFrameBody =
  | {
      readonly type: "hello";
      readonly announced: AnnouncedState;
      readonly neighbors: readonly HelloNeighborEntry[];
    }
  | { readonly type: "echo_request"; readonly number: number; readonly size: number }
  | {
      readonly type: "echo_reply";
      readonly number: number;
      readonly size: number;
      readonly rssi: number;
      readonly snr: number;
    }
  | {
      readonly type: "test";
      readonly run: number;
      readonly index: number;
      readonly count: number;
      readonly size: number;
      readonly interval: number;
    }
  | {
      readonly type: "fragment";
      readonly version: number;
      readonly index: number;
      readonly count: number;
      readonly size: number;
      readonly remaining: number;
      readonly data: Uint8Array;
    }
  | {
      readonly type: "report";
      readonly version: number;
      readonly size: number;
      readonly count: number;
      readonly missing: readonly number[];
    };

/** A frame on the air: its header, the channel it was sent on and its body. */
export interface SimulatedFrame {
  readonly source: NodeIdentifier;
  readonly epoch: number;
  readonly sequence: number;
  readonly destination: NodeIdentifier;
  readonly channel: Pick<RadioSettings, "freq" | "sf" | "bw" | "cr">;
  readonly body: SimulatedFrameBody;
}

/** Link quality of the tests: fixed values for each kind of frame. */
function defaultHearing(frame: SimulatedFrame): LinkQuality {
  const body = frame.body;
  switch (body.type) {
    case "test":
      return {
        rssi: -40 - (body.index % 3) * 0.5,
        snr: 9.5 + (body.index % 2) * 0.25,
        frequencyError: -1200,
      };
    case "echo_request":
      return {
        rssi: -60 - (body.number % 3),
        snr: 7.5 + (body.number % 2) * 0.25,
        frequencyError: -1200,
      };
    case "echo_reply":
      return { rssi: -62, snr: 6.5, frequencyError: -1200 };
    default:
      return { rssi: -55, snr: 8.5, frequencyError: -1200 };
  }
}

/** Free heap that `status` reports when the behavior does not give one. */
const DEFAULT_FREE_HEAP = 200_000;

const ACCESS_POINT_CHANNEL = 1;

/**
 * Time a simulated node takes between the end of one frame and the start of the next one: the
 * pass of the main loop that takes it and the setup of the transceiver. Nobody measured it on the
 * boards; it is the value that PACKET_GAP_ESTIMATE_MILLISECONDS of measurements/run-timing.ts
 * assumes too, so a test of that estimate against the simulator cannot fail on its value.
 */
const SIMULATED_PACKET_GAP_MILLISECONDS = 3;

/** A list as the details of the firmware write it: "125, 250 or 500". */
function listWithOr(items: readonly (string | number)[]): string {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} or ${String(items.at(-1))}`;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** A node identifier as the console writes it, in uppercase hexadecimal. */
function formatNodeIdentifier(value: number): NodeIdentifier {
  return value.toString(16).toUpperCase().padStart(NODE_ID_HEXADECIMAL_DIGITS, "0");
}

/** An unsigned decimal number, or null for any other word; above 2^32 it saturates there. */
function parseUnsigned(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) {
    return null;
  }
  return Math.min(Number(text), 2 ** 32);
}

/** A register value: a signed 32-bit decimal, an unsigned 32-bit decimal or 0x hexadecimal. */
function parseRegisterValue(text: string): number | null {
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  const hexadecimal = /^0[xX]/.test(digits);
  const body = hexadecimal ? digits.slice(2) : digits;
  if (!(hexadecimal ? /^[0-9a-fA-F]+$/ : /^\d+$/).test(body)) {
    return null;
  }
  const magnitude = Number.parseInt(body, hexadecimal ? 16 : 10);
  if (negative ? magnitude > 2 ** 31 : magnitude > 2 ** 32 - 1) {
    return null;
  }
  return (negative ? -magnitude : magnitude) | 0;
}

/**
 * The nodes that hear each other, their time source and the work in progress, so that settle()
 * knows when the simulation is idle.
 */
export class SimulatedNetwork {
  readonly timeSource: TimeSource;
  readonly #nodes = new Set<SimulatedNode>();
  /** Calls scheduled that end in work, such as a frame on the air or a deadline. */
  #scheduledWork = 0;
  /** Work that waits for something other than the clock, such as a signature check. */
  readonly #asynchronousWork = new Set<Promise<unknown>>();

  constructor(timeSource: TimeSource) {
    this.timeSource = timeSource;
  }

  get nodes(): readonly SimulatedNode[] {
    return [...this.#nodes];
  }

  add(node: SimulatedNode): void {
    this.#nodes.add(node);
  }

  /** Delivers a frame that ends now to every other node of the network. */
  broadcast(sender: SimulatedNode, frame: SimulatedFrame): void {
    for (const node of this.#nodes) {
      if (node !== sender) {
        node.receiveFrame(frame);
      }
    }
  }

  /**
   * Calls `callback` after `delayMilliseconds`. Work counts for settle(); a periodic timer, such
   * as the HELLO period, does not.
   */
  schedule(callback: () => void, delayMilliseconds: number, isWork = true): () => void {
    let pending = true;
    if (isWork) {
      this.#scheduledWork += 1;
    }
    const finish = (): void => {
      if (pending) {
        pending = false;
        if (isWork) {
          this.#scheduledWork -= 1;
        }
      }
    };
    const cancel = this.timeSource.schedule(() => {
      finish();
      callback();
    }, delayMilliseconds);
    return () => {
      finish();
      cancel();
    };
  }

  /** Keeps `promise` as work in progress until it settles. */
  track(promise: Promise<unknown>): void {
    this.#asynchronousWork.add(promise);
    void promise.finally(() => this.#asynchronousWork.delete(promise)).catch(() => undefined);
  }

  /**
   * Resolves once no node has work left, moving time forward to each scheduled call in the
   * meantime. Only the tests settle a network, on a ManualTimeSource; the simulation build lets
   * the system clock run.
   */
  async settle(): Promise<void> {
    const clock = this.timeSource;
    if (!(clock instanceof ManualTimeSource)) {
      throw new Error("only a network on a ManualTimeSource settles");
    }
    for (;;) {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      if (this.#asynchronousWork.size > 0) {
        await Promise.allSettled(this.#asynchronousWork);
        continue;
      }
      if (this.#scheduledWork === 0) {
        return;
      }
      clock.advanceToNextCall();
    }
  }
}

/** Blocks of a program without waits that the simulated node runs before it yields. */
const MAXIMUM_PROGRAM_BLOCKS = 1000;

interface Neighbor {
  readonly id: NodeIdentifier;
  announced: AnnouncedState | null;
  rssi: number;
  snr: number;
  lastHeardHostTime: number;
}

interface QueuedTransmission {
  readonly type: TransmissionType;
  /** Builds the body when the frame goes on the air; null drops the transmission. */
  readonly build: () => {
    readonly body: SimulatedFrameBody;
    readonly destination: NodeIdentifier;
  } | null;
  readonly onStart?: (frame: SimulatedFrame, startHostTime: number) => void;
  readonly onEnd?: (frame: SimulatedFrame, endHostTime: number) => void;
  /** Sequence of a frame sent again with `resend`. */
  readonly sequence?: number;
}

interface Burst {
  readonly version: number;
  readonly size: number;
  readonly cause: BurstCause;
  readonly trigger: NodeIdentifier | null;
  readonly indices: number[];
  sent: number;
  startHostTime: number | null;
}

interface ImageReception {
  readonly version: number;
  readonly bytes: Uint8Array;
  readonly held: boolean[];
  /** Exact length, once the last fragment arrived. */
  length: number | null;
  /** Size and count of the last fragment, for the report. */
  fragmentSize: number;
  fragmentCount: number;
  source: NodeIdentifier;
  fragments: number;
  reports: number;
  readonly startNodeTime: number;
  cancelDeadline: () => void;
  /** True while a report waits for the sender to come back to the neighbor table. */
  waitsForSource: boolean;
  /** True while a report waits for the end of a suspension. */
  reportHeld: boolean;
}

interface SenderRun {
  readonly run: number;
  readonly count: number;
  readonly size: number;
  readonly interval: number;
  sent: number;
  stopRequested: boolean;
  frameInFlight: boolean;
  held: boolean;
  firstStartHostTime: number | null;
  lastEndHostTime: number | null;
}

interface ReceiverRun {
  readonly source: NodeIdentifier;
  readonly run: number;
  readonly count: number;
  received: number;
  rssiSum: number;
  snrSum: number;
  rssiMinimum: number;
  rssiMaximum: number;
  readonly first: number;
  last: number;
  cancelDeadline: () => void;
}

interface PendingEcho {
  readonly destination: NodeIdentifier;
  readonly number: number;
  readonly size: number;
  startHostTime: number | null;
  cancelTimeout: () => void;
}

type CommandPrecondition = (typeof COMMAND_PRECONDITIONS)[number]["name"];

/** Runs one form of a command on a node; the table itself is CONSOLE_COMMANDS of the contract. */
type CommandHandler = (node: SimulatedNode, invocation: CommandInvocation) => void | Promise<void>;

class CommandInvocation {
  readonly command: ConsoleCommandDefinition;
  readonly arguments: readonly string[];
  readonly #reject: (reason: ErrorReason, detail?: string) => void;

  constructor(
    command: ConsoleCommandDefinition,
    argumentsList: readonly string[],
    reject: (reason: ErrorReason, detail?: string) => void,
  ) {
    this.command = command;
    this.arguments = argumentsList;
    this.#reject = reject;
  }

  reject(reason: ErrorReason, detail?: string): void {
    this.#reject(reason, detail);
  }

  rejectUsage(): void {
    this.#reject("usage", this.command.usage);
  }

  /** An unsigned number from minimum to maximum; reports its own error and returns null. */
  readUnsigned(index: number, name: string, minimum: number, maximum: number): number | null {
    const value = parseUnsigned(this.arguments[index]);
    if (value === null) {
      this.rejectUsage();
      return null;
    }
    if (value < minimum || value > maximum) {
      this.#reject("out_of_range", `${name} ${minimum}..${maximum}`);
      return null;
    }
    return value;
  }
}

function selectForm(
  command: ConsoleCommandDefinition,
  argumentsList: readonly string[],
): ConsoleCommandForm | null {
  for (const candidate of command.forms) {
    const selected =
      candidate.selector === null ||
      (argumentsList.length > 0 && argumentsList[0] === candidate.selector);
    if (
      selected &&
      argumentsList.length >= candidate.minimumArguments &&
      argumentsList.length <= candidate.maximumArguments
    ) {
      return candidate;
    }
  }
  return null;
}

let creationObserver: ((node: SimulatedNode) => void) | null = null;

/**
 * Calls observer with every node created from now on; the test setup (event-shape-check.setup.ts)
 * uses it to compare the lines of every simulated node with those of the firmware.
 */
export function observeSimulatedNodeCreation(observer: (node: SimulatedNode) => void): void {
  creationObserver = observer;
}

export class SimulatedNode implements NodePort {
  /** What the node does for each action of the command table. */
  static readonly #HANDLERS: { readonly [Action in ConsoleCommandAction]: CommandHandler } = {
    listCommands: (node) => node.#executeHelp(),
    reportStatus: (node) => node.#executeStatus(),
    reportRadio: (node) => node.#executeRadioQuery(),
    resetRadio: (node) => node.#executeRadioReset(),
    changeRadio: (node, invocation) => node.#executeRadioChange(invocation),
    requestEcho: (node, invocation) => node.#executeEcho(invocation),
    stopRun: (node, invocation) => node.#executeRunStop(invocation),
    startRun: (node, invocation) => node.#executeRun(invocation),
    enableWireless: (node) => node.#setWirelessEnabled(true),
    disableWireless: (node) => node.#setWirelessEnabled(false),
    resendLastFrame: (node, invocation) => node.#executeResend(invocation),
    releasePresence: (node, invocation) => node.#executePresence(invocation),
    holdPresence: (node, invocation) => node.#executePresence(invocation),
    loadRegisters: (node, invocation) => node.#executeLoadRegisters(invocation),
    loadImage: (node, invocation) => node.#executeLoadImage(invocation),
    activateAvailableVersion: (node, invocation) => node.#executeActivate(invocation),
    changeFragmentSize: (node, invocation) => node.#executeFragmentSize(invocation),
    reportProgram: (node) => node.#executeProgram(),
  };

  readonly identifier: NodeIdentifier;
  readonly model: BoardModel;
  readonly commands: string[] = [];
  readonly emittedLines: string[] = [];
  readonly network: SimulatedNetwork;
  behavior: SimulatedNodeBehavior;
  readonly #timeSource: TimeSource;
  readonly #epoch: number;
  readonly #bootHostTime: number;
  readonly #listeners = new Set<(event: ConsoleEvent, hostTime: number) => void>();
  readonly #lineListeners = new Set<(line: string) => void>();
  #radio: NodeRadioSettings;
  #radioRefusalsLeft: number;
  #wirelessEnabled: boolean;
  #wirelessClients: number;
  #commandChain: Promise<void> = Promise.resolve();
  // Transmission
  readonly #queue: QueuedTransmission[] = [];
  #transmitting = false;
  #pumpScheduled = false;
  #sequence = 0;
  #sentCount = 0;
  #receivedCount = 0;
  #lastFrame: {
    readonly type: TransmissionType;
    readonly destination: NodeIdentifier;
    readonly body: SimulatedFrameBody;
    readonly sequence: number;
  } | null = null;
  // Presence and neighbors
  readonly #neighbors = new Map<NodeIdentifier, Neighbor>();
  #holdSeconds: number | null = null;
  #holdEndHostTime = 0;
  #cancelHold = (): void => {};
  #helloQueued = false;
  // Echo and runs
  #echoCounter = 0;
  #pendingEcho: PendingEcho | null = null;
  #runCounter = 0;
  #senderRun: SenderRun | null = null;
  readonly #receiverRuns = new Map<NodeIdentifier, ReceiverRun>();
  // Transfer and VM
  #activeVersion = 0;
  #availableVersion = 0;
  #availableImage: Uint8Array | null = null;
  #fragmentSize = DEFAULT_FRAGMENT_SIZE;
  readonly #bursts: Burst[] = [];
  #currentBurst: Burst | null = null;
  #imageReception: ImageReception | null = null;
  readonly #fragmentDeliveries = new Map<string, number>();
  /** Its GPIO pins read low unless a test sets what the circuit puts on them. */
  readonly pins: SimulatedPinBank;
  readonly #machine: VirtualMachine;
  #program: Uint8Array = new Uint8Array(0);
  #faultSinceActivation: VmFault | null = null;
  /** Bit 3 of the vm byte: the program faulted since the previous HELLO. */
  #faultedSinceHello = false;
  #cancelProgram: () => void = () => {};

  constructor(
    identifier: NodeIdentifier,
    model: BoardModel,
    timeSource: TimeSource,
    behavior: SimulatedNodeBehavior = {},
    network: SimulatedNetwork = new SimulatedNetwork(timeSource),
  ) {
    this.identifier = identifier;
    this.model = model;
    this.pins = new SimulatedPinBank();
    this.#machine = new VirtualMachine(this.pins);
    this.#timeSource = timeSource;
    this.behavior = behavior;
    this.network = network;
    this.#epoch = behavior.epoch ?? 1;
    this.#bootHostTime = behavior.bootHostTime ?? timeSource.now() - 1000;
    this.#radio = this.#defaultRadio();
    this.#radioRefusalsLeft = behavior.radioRefusal?.times ?? 0;
    this.#wirelessEnabled = behavior.wireless?.enabled ?? false;
    this.#wirelessClients = behavior.wireless?.clients ?? 0;
    network.add(this);
    creationObserver?.(this);
  }

  sendCommand(command: string): Promise<void> {
    this.commands.push(command);
    const execution = this.#commandChain.then(() => this.#executeLine(command));
    this.#commandChain = execution.catch(() => undefined);
    this.network.track(execution);
    return Promise.resolve();
  }

  subscribe(listener: (event: ConsoleEvent, hostTime: number) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Receives every console line the node writes; returns the function that ends it. */
  subscribeToLines(listener: (line: string) => void): () => void {
    this.#lineListeners.add(listener);
    return () => this.#lineListeners.delete(listener);
  }

  /** Current modulation, to check what a test left behind. */
  get modulation(): { readonly sf: number; readonly bw: number; readonly cr: number } {
    return { sf: this.#radio.sf, bw: this.#radio.bw, cr: this.#radio.cr };
  }

  /** Active and available versions, to check the outcome of an update. */
  get versions(): { readonly active: number; readonly available: number } {
    return { active: this.#activeVersion, available: this.#availableVersion };
  }

  /** Seconds of the HELLO hold that `presence off` asked for; null while the HELLO messages are on. */
  get presenceHoldSeconds(): number | null {
    return this.#holdSeconds;
  }

  /** Resolves once the commands sent so far, and the work they started on the network, end. */
  settle(): Promise<void> {
    return this.network.settle();
  }

  /**
   * Starts what a node does on its own after boot: the HELLO messages, with the first one in the
   * first HELLO window and the next ones every period with its jitter. The program runs on its own
   * from its activation. Returns the function that stops them.
   */
  start(random: () => number = Math.random): () => void {
    let cancelHello = (): void => {};
    const scheduleHello = (delay: number): void => {
      cancelHello = this.network.schedule(
        () => {
          this.sendHello();
          scheduleHello(HELLO_PERIOD_MILLISECONDS + (2 * random() - 1) * HELLO_JITTER_MILLISECONDS);
        },
        delay,
        false,
      );
    };
    scheduleHello(
      FIRST_HELLO_MINIMUM_DELAY_MILLISECONDS +
        random() *
          (FIRST_HELLO_MAXIMUM_DELAY_MILLISECONDS - FIRST_HELLO_MINIMUM_DELAY_MILLISECONDS),
    );
    return () => {
      cancelHello();
      this.#cancelProgram();
    };
  }

  /** Transmits a HELLO as soon as the radio is free and the HELLO messages are not held. */
  sendHello(): void {
    if (this.#helloQueued) {
      return;
    }
    this.#helloQueued = true;
    this.#enqueue({
      type: "hello",
      build: () => {
        this.#helloQueued = false;
        const neighbors = this.#currentNeighbors().map((neighbor) => ({
          id: neighbor.id,
          rssi: Math.round(neighbor.rssi),
          snr: Math.round(neighbor.snr * 4) / 4,
        }));
        const announced = this.#announcedState();
        // The failing bit covers the interval up to this HELLO; the next one starts clean.
        this.#faultedSinceHello = false;
        return {
          destination: BROADCAST_IDENTIFIER,
          body: { type: "hello", announced, neighbors },
        };
      },
    });
  }

  /**
   * Hears a frame that ends now: from another node of the network, or from a node outside it,
   * such as a node the panel does not reach.
   */
  receiveFrame(frame: SimulatedFrame): void {
    if (!settingsMatch(frame.channel, this.#radio, FREQUENCY_AND_MODULATION_FIELDS)) {
      return;
    }
    const body = frame.body;
    if (body.type === "test" && this.behavior.losesPacket?.(body.run, body.index) === true) {
      return;
    }
    if (
      body.type === "echo_request" &&
      frame.destination === this.identifier &&
      this.behavior.losesEchoRequest?.(body.number) === true
    ) {
      return;
    }
    if (body.type === "fragment") {
      const key = `${body.version}:${body.index}`;
      const delivery = (this.#fragmentDeliveries.get(key) ?? 0) + 1;
      this.#fragmentDeliveries.set(key, delivery);
      if (this.behavior.losesFragment?.(body.version, body.index, delivery) === true) {
        return;
      }
    }
    const quality = (this.behavior.hearing ?? defaultHearing)(frame);
    this.#receivedCount += 1;
    this.#recordFrame(frame.source, quality);
    if (frame.destination !== this.identifier && frame.destination !== BROADCAST_IDENTIFIER) {
      return;
    }
    switch (body.type) {
      case "hello":
        this.#receiveHello(frame, body, quality);
        break;
      case "echo_request":
        this.#receiveEchoRequest(frame, body, quality);
        break;
      case "echo_reply":
        this.#receiveEchoReply(frame, body, quality);
        break;
      case "test":
        this.#receiveTestPacket(frame, body, quality);
        break;
      case "fragment":
        this.#receiveFragment(frame, body, quality);
        break;
      case "report":
        this.#receiveReport(frame, body);
        break;
    }
    const reception = this.#imageReception;
    if (reception !== null && reception.waitsForSource && reception.source === frame.source) {
      reception.waitsForSource = false;
      this.#reportMissing(reception);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Console output

  #nodeTime(): number {
    return Math.round(this.#timeSource.now() - this.#bootHostTime);
  }

  #emitLine(line: string): void {
    this.emittedLines.push(line);
    for (const listener of this.#lineListeners) {
      listener(line);
    }
    const parsed = parseConsoleLine(line);
    if (parsed.kind !== "event") {
      return;
    }
    for (const listener of this.#listeners) {
      listener(parsed.event, this.#timeSource.now());
    }
  }

  #emit(name: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.#emitLine(JSON.stringify({ t: this.#nodeTime(), ev: name, ...fields }));
  }

  #emitError(command: string, reason: ErrorReason, detail?: string): void {
    this.#emit(
      "error",
      detail === undefined ? { cmd: command, reason } : { cmd: command, reason, detail },
    );
    this.#emitLine(`error ${command} ${reason}`);
  }

  #linkFields(quality: { readonly rssi: number; readonly snr: number }): {
    rssi: number;
    snr: number;
  } {
    return { rssi: roundTo(quality.rssi, RSSI_DECIMALS), snr: roundTo(quality.snr, SNR_DECIMALS) };
  }

  // -------------------------------------------------------------------------------------------
  // Commands

  async #executeLine(line: string): Promise<void> {
    const words = commandWordsOf(line);
    const word = words[0] ?? "";
    const command = findConsoleCommand(word);
    if (line.length > lineCapacityOf(line)) {
      this.#emitError(word.slice(0, ERROR_COMMAND_WORD_LENGTH), "line_too_long");
      return;
    }
    if (words.length === 0) {
      return;
    }
    if (command === null) {
      this.#emitError(word.slice(0, ERROR_COMMAND_WORD_LENGTH), "unknown_command");
      return;
    }
    const argumentsList = words.slice(1);
    const selected = selectForm(command, argumentsList);
    if (selected === null) {
      this.#emitError(command.name, "usage", command.usage);
      return;
    }
    const preconditions = selected.preconditions as readonly CommandPrecondition[];
    const unmet = COMMAND_PRECONDITIONS.find(
      (check) => preconditions.includes(check.name) && !this.#meets(check.name),
    );
    if (unmet !== undefined) {
      this.#emitError(command.name, unmet.refusalReason, unmet.refusalDetail ?? undefined);
      return;
    }
    const invocation = new CommandInvocation(command, argumentsList, (reason, detail) =>
      this.#emitError(command.name, reason, detail),
    );
    await SimulatedNode.#HANDLERS[selected.action](this, invocation);
  }

  #meets(precondition: CommandPrecondition): boolean {
    switch (precondition) {
      case "rejectedDuringRun":
        return !this.#isRunActive();
      case "rejectedDuringEcho":
        return this.#pendingEcho === null;
      case "needsRadio":
        // The radio of a simulated node always starts.
        return true;
    }
  }

  // The handlers of the command table.

  #executeHelp(): void {
    this.#emitLine("commands:");
    for (const command of CONSOLE_COMMANDS) {
      this.#emitLine(`  ${command.usage}`);
    }
  }

  #executeStatus(): void {
    this.#emit("status", {
      id: this.identifier,
      model: this.model,
      epoch: this.#epoch,
      tx: this.#sentCount,
      rx: this.#receivedCount,
      dropped: 0,
      heap: this.behavior.freeHeap ?? DEFAULT_FREE_HEAP,
    });
    this.#emitRadio();
    this.#emitWireless();
    this.#emitPresence();
    this.#emitVirtualMachine();
    this.#emitTransfer();
    const now = this.#timeSource.now();
    for (const neighbor of this.#currentNeighbors()) {
      const announced = neighbor.announced;
      this.#emit("neighbor", {
        id: neighbor.id,
        model: announced?.model ?? null,
        version: announced?.version ?? 0,
        available: announced?.available ?? 0,
        vm_fault: announced?.vmFault ?? null,
        vm_failing: announced?.vmFailing ?? false,
        tx: announced?.transmitted ?? 0,
        ...this.#linkFields(neighbor),
        age: Math.round(now - neighbor.lastHeardHostTime),
      });
    }
  }

  #executeRadioQuery(): void {
    this.#emitRadio();
  }

  #executeRadioReset(): void {
    if (this.#refusesRadio()) {
      return;
    }
    this.#applyRadio(this.#defaultRadio());
  }

  #executeRadioChange(invocation: CommandInvocation): void {
    if (invocation.arguments.length % 2 !== 0) {
      invocation.rejectUsage();
      return;
    }
    if (this.#refusesRadio()) {
      return;
    }
    let candidate = { ...this.#radio };
    for (let index = 0; index + 1 < invocation.arguments.length; index += 2) {
      const key = invocation.arguments[index] ?? "";
      const value = invocation.arguments[index + 1] ?? "";
      const update = this.#updateRadioSetting(candidate, key, value);
      if (!update.accepted) {
        invocation.reject(update.reason, update.detail);
        return;
      }
      candidate = update.settings;
    }
    this.#applyRadio(candidate);
  }

  #executeEcho(invocation: CommandInvocation): void {
    const text = invocation.arguments[0] ?? "";
    const digits = new RegExp(`^[0-9a-fA-F]{1,${NODE_ID_HEXADECIMAL_DIGITS}}$`);
    const value = digits.test(text) ? Number.parseInt(text, 16) : null;
    const destination = value === null ? null : formatNodeIdentifier(value);
    if (
      destination === null ||
      destination === NO_NODE_IDENTIFIER ||
      destination === BROADCAST_IDENTIFIER ||
      destination === this.identifier
    ) {
      invocation.reject("usage", `${invocation.command.usage} with the id of another node`);
      return;
    }
    let size = DEFAULT_ECHO_SIZE;
    if (invocation.arguments.length > 1) {
      const read = invocation.readUnsigned(1, "size", MINIMUM_ECHO_SIZE, MAXIMUM_ECHO_SIZE);
      if (read === null) {
        return;
      }
      size = read;
    }
    this.#echoCounter += 1;
    const echo: PendingEcho = {
      destination,
      number: this.#echoCounter,
      size,
      startHostTime: null,
      cancelTimeout: () => {},
    };
    this.#pendingEcho = echo;
    this.#enqueue({
      type: "echo_request",
      build: () => ({ destination, body: { type: "echo_request", number: echo.number, size } }),
      onStart: (frame, startHostTime) => {
        echo.startHostTime = startHostTime;
        const timeout = echoLossDeadlineMilliseconds(this.#timeOnAirMicroseconds(frame));
        echo.cancelTimeout = this.network.schedule(() => {
          if (this.#pendingEcho !== echo) {
            return;
          }
          this.#pendingEcho = null;
          this.#emit("echo_lost", { dst: destination, n: echo.number, size, timeout });
          this.#emitLine(`echo ${destination} lost`);
        }, timeout);
      },
    });
  }

  #executeRunStop(invocation: CommandInvocation): void {
    const run = this.#senderRun;
    if (run === null) {
      invocation.reject("usage", "no run in progress");
      return;
    }
    run.stopRequested = true;
    this.#finishSendingIfOver();
  }

  #executeRun(invocation: CommandInvocation): void {
    const count = invocation.readUnsigned(0, "count", MINIMUM_RUN_COUNT, MAXIMUM_RUN_COUNT);
    if (count === null) {
      return;
    }
    const size = invocation.readUnsigned(1, "size", MINIMUM_TEST_SIZE, MAXIMUM_TEST_SIZE);
    if (size === null) {
      return;
    }
    const interval = invocation.readUnsigned(
      2,
      "interval",
      MINIMUM_RUN_INTERVAL_MILLISECONDS,
      MAXIMUM_RUN_INTERVAL_MILLISECONDS,
    );
    if (interval === null) {
      return;
    }
    this.#runCounter += 1;
    this.#senderRun = {
      run: this.#runCounter,
      count,
      size,
      interval,
      sent: 0,
      stopRequested: false,
      frameInFlight: false,
      held: this.behavior.holdsRun === true,
      firstStartHostTime: null,
      lastEndHostTime: null,
    };
    this.#emit("run_start", { run: this.#runCounter, count, size, interval });
    this.#emitLine(`run ${this.#runCounter} start ${count}x${size}`);
    if (!this.#senderRun.held) {
      this.#transmitNextTestPacket();
    }
  }

  #setWirelessEnabled(enabled: boolean): void {
    if (this.#wirelessEnabled === enabled) {
      return;
    }
    this.#wirelessEnabled = enabled;
    if (!enabled) {
      this.#wirelessClients = 0;
    }
    this.#emitWireless();
    this.#emitLine(`wifi ${enabled ? "on" : "off"}`);
  }

  #executeResend(invocation: CommandInvocation): void {
    const last = this.#lastFrame;
    if (last === null) {
      invocation.reject("usage", "nothing to resend");
      return;
    }
    this.#enqueue({
      type: last.type,
      sequence: last.sequence,
      build: () => ({ destination: last.destination, body: last.body }),
    });
  }

  #executePresence(invocation: CommandInvocation): void {
    if (this.behavior.presenceRefusal !== undefined) {
      invocation.reject(this.behavior.presenceRefusal);
      return;
    }
    if (invocation.arguments[0] === "on") {
      this.#endHold();
      this.#emitPresence();
      this.#emitLine("hello on");
      return;
    }
    const seconds = invocation.readUnsigned(
      1,
      "seconds",
      MINIMUM_PRESENCE_HOLD_SECONDS,
      MAXIMUM_PRESENCE_HOLD_SECONDS,
    );
    if (seconds === null) {
      return;
    }
    this.#cancelHold();
    this.#holdSeconds = seconds;
    this.#holdEndHostTime = this.#timeSource.now() + seconds * 1000;
    this.#cancelHold = this.network.schedule(
      () => {
        this.#endHold();
        this.#emitPresence();
        this.#emitLine("hello on (hold expired)");
      },
      seconds * 1000,
      false,
    );
    this.#emitPresence();
    this.#emitLine("hello off");
  }

  #executeLoadRegisters(invocation: CommandInvocation): void {
    const values: number[] = [];
    for (const text of invocation.arguments) {
      const value = parseRegisterValue(text);
      if (value === null) {
        invocation.reject("out_of_range", REGISTER_VALUE_DETAIL);
        return;
      }
      values.push(value);
    }
    this.#machine.setRegisters(values);
    this.#emitVirtualMachine();
    this.#emitLine("VM: registers loaded");
  }

  /** Format first, then version, then signature and program, as the contract orders. */
  async #executeLoadImage(invocation: CommandInvocation): Promise<void> {
    const hex = invocation.arguments[0] ?? "";
    if (hex.length > 2 * MAXIMUM_IMAGE_SIZE) {
      invocation.reject("invalid_image", `format: longer than ${MAXIMUM_IMAGE_SIZE} bytes`);
      return;
    }
    const bytes = parseHex(hex);
    if (bytes === null) {
      invocation.reject("invalid_image", "format: not hexadecimal");
      return;
    }
    const decoding = decodeImage(bytes);
    if (!decoding.valid && decoding.reason === "format") {
      invocation.reject("invalid_image", `format: ${IMAGE_FORMAT_DEFECTS[decoding.defect]}`);
      return;
    }
    if (readImageVersion(bytes) <= this.#availableVersion) {
      invocation.reject("version_not_newer", `available version ${this.#availableVersion}`);
      return;
    }
    const verification = await verifyImage(
      bytes,
      this.behavior.operatorPublicKey ?? DEFAULT_OPERATOR_PUBLIC_KEY,
    );
    if (!verification.valid) {
      invocation.reject(
        "invalid_image",
        verification.reason === "signature"
          ? "signature: not signed by the operator"
          : verification.reason === "program"
            ? `program: ${verification.defect} at ${verification.address}`
            : `format: ${IMAGE_FORMAT_DEFECTS[verification.defect]}`,
      );
      return;
    }
    this.#installImage(bytes, "console", null, 0, 0, 0);
  }

  #executeActivate(invocation: CommandInvocation): void {
    const version = invocation.readUnsigned(0, "version", 0, MAXIMUM_IMAGE_VERSION);
    if (version === null) {
      return;
    }
    if (version !== this.#availableVersion) {
      invocation.reject("not_available", `available version ${this.#availableVersion}`);
      return;
    }
    if (version <= this.#activeVersion) {
      invocation.reject("version_not_newer", `active version ${this.#activeVersion}`);
      return;
    }
    this.#activate("console", null);
  }

  #executeFragmentSize(invocation: CommandInvocation): void {
    if (invocation.arguments.length > 0) {
      const size = invocation.readUnsigned(
        0,
        "bytes",
        MINIMUM_FRAGMENT_SIZE,
        MAXIMUM_FRAGMENT_SIZE,
      );
      if (size === null) {
        return;
      }
      this.#fragmentSize = size;
    }
    this.#emitTransfer();
  }

  #executeProgram(): void {
    this.#emit("program", {
      version: this.#activeVersion,
      size: this.#program.length,
      code: formatHex(this.#program),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Radio settings

  #defaultRadio(): NodeRadioSettings {
    return {
      ...DEFAULT_RADIO_SETTINGS,
      lna: hasLowNoiseAmplifier(this.model) ? DEFAULT_LNA_MODE : null,
    };
  }

  #refusesRadio(): boolean {
    if (this.behavior.ignoresRadio === true) {
      return true;
    }
    if (this.#radioRefusalsLeft > 0) {
      this.#radioRefusalsLeft -= 1;
      this.#emitError("radio", this.behavior.radioRefusal?.reason ?? "busy");
      return true;
    }
    return false;
  }

  #applyRadio(settings: NodeRadioSettings): void {
    this.#radio = settings;
    this.#emitRadio();
    const power = settings.power >= 0 ? `+${settings.power}` : String(settings.power);
    this.#emitLine(`radio ${settings.sf}/${settings.bw} ${power} dBm`);
  }

  /** One `<key> <value>` pair of the radio command, checked as the firmware checks it. */
  #updateRadioSetting(
    settings: NodeRadioSettings,
    key: string,
    value: string,
  ):
    | { readonly accepted: true; readonly settings: NodeRadioSettings }
    | { readonly accepted: false; readonly reason: ErrorReason; readonly detail: string } {
    const integer = (
      minimum: number,
      maximum: number,
      valueUsage: string | null,
    ): { accepted: false; reason: ErrorReason; detail: string } | number => {
      const number = parseUnsigned(value);
      if (number === null) {
        return reject("usage", `${key} ${valueUsage ?? `<${minimum}..${maximum}>`}`);
      }
      return number < minimum || number > maximum
        ? reject("out_of_range", `${key} ${minimum}..${maximum}`)
        : number;
    };
    const reject = (reason: ErrorReason, detail: string) =>
      ({ accepted: false, reason, detail }) as const;
    const accept = (changes: Partial<NodeRadioSettings>) =>
      ({ accepted: true, settings: { ...settings, ...changes } }) as const;
    switch (key) {
      case "freq": {
        if (!/^\d+(\.\d+)?$/.test(value)) {
          return reject("usage", `${key} <MHz>`);
        }
        const frequency = Number(value);
        if (frequency < MINIMUM_FREQUENCY_MEGAHERTZ || frequency > MAXIMUM_FREQUENCY_MEGAHERTZ) {
          return reject(
            "out_of_range",
            `${key} ${MINIMUM_FREQUENCY_MEGAHERTZ.toFixed(1)}..${MAXIMUM_FREQUENCY_MEGAHERTZ.toFixed(1)}`,
          );
        }
        return accept({ freq: roundTo(frequency, FREQUENCY_DECIMALS) });
      }
      case "sf": {
        const read = integer(MINIMUM_SPREADING_FACTOR, MAXIMUM_SPREADING_FACTOR, null);
        return typeof read === "number" ? accept({ sf: read }) : read;
      }
      case "bw": {
        const number = parseUnsigned(value);
        if (number === null) {
          return reject("usage", `${key} <kHz>`);
        }
        return (BANDWIDTHS_KILOHERTZ as readonly number[]).includes(number)
          ? accept({ bw: number })
          : reject("out_of_range", `${key} ${listWithOr(BANDWIDTHS_KILOHERTZ)}`);
      }
      case "cr": {
        const read = integer(
          MINIMUM_CODING_RATE_DENOMINATOR,
          MAXIMUM_CODING_RATE_DENOMINATOR,
          null,
        );
        return typeof read === "number" ? accept({ cr: read }) : read;
      }
      case "preamble": {
        const read = integer(MINIMUM_PREAMBLE_LENGTH, MAXIMUM_PREAMBLE_LENGTH, "<symbols>");
        return typeof read === "number" ? accept({ preamble: read }) : read;
      }
      case "sync": {
        const read = integer(MINIMUM_SYNC_WORD, MAXIMUM_SYNC_WORD, null);
        return typeof read === "number" ? accept({ sync: read }) : read;
      }
      case "power": {
        const number = parseUnsigned(value);
        if (number === null) {
          return reject("usage", `${key} <dBm>`);
        }
        if (isTransmitPowerReachable(this.model, number)) {
          return accept({ power: number });
        }
        const range = TRANSMIT_POWER_RANGES[this.model];
        const additional = range.additionalValues.map((power) => ` or ${power}`).join("");
        return reject(
          "unreachable_power",
          `${key} ${range.minimum}..${range.maximum}${additional} on ${this.model}`,
        );
      }
      case "lna": {
        if (!hasLowNoiseAmplifier(this.model)) {
          return reject(
            "not_supported",
            `${key} exists only on ${listWithOr(LOW_NOISE_AMPLIFIER_BOARD_MODELS)}`,
          );
        }
        return (LNA_MODES as readonly string[]).includes(value)
          ? accept({ lna: value as LnaMode })
          : reject("usage", `${key} ${LNA_MODES.join("|")}`);
      }
      default:
        return reject("usage", `unknown key ${key}`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Events of the state

  #emitRadio(): void {
    const radio = this.#radio;
    const gain =
      FRONT_END_GAIN_STEPS[this.model].find(
        (step) => radio.power >= step.minimumAntennaDbm && radio.power <= step.maximumAntennaDbm,
      )?.gainDb ?? 0;
    this.#emit("radio", {
      freq: radio.freq,
      sf: radio.sf,
      bw: radio.bw,
      cr: radio.cr,
      preamble: radio.preamble,
      sync: radio.sync,
      power: radio.power,
      chip: radio.power - gain,
      lna: radio.lna,
    });
  }

  #emitWireless(): void {
    this.#emit("wifi", {
      state: this.#wirelessEnabled ? "on" : "off",
      ssid: `${ACCESS_POINT_NAME_PREFIX}${this.identifier}`,
      channel: ACCESS_POINT_CHANNEL,
      clients: this.#wirelessClients,
    });
  }

  #emitPresence(): void {
    this.#emit(
      "presence",
      this.#holdSeconds === null
        ? { state: "on", remaining: null }
        : {
            state: "off",
            remaining: Math.ceil((this.#holdEndHostTime - this.#timeSource.now()) / 1000),
          },
    );
  }

  #emitVirtualMachine(): void {
    this.#emit("vm", {
      version: this.#activeVersion,
      size: this.#program.length,
      starts: this.#machine.startCount,
      registers: [...this.#machine.registers],
    });
  }

  #emitTransfer(): void {
    const reception = this.#imageReception;
    this.#emit("transfer", {
      active: this.#activeVersion,
      available: this.#availableVersion,
      receiving: reception?.version ?? null,
      missing:
        reception === null
          ? null
          : reception.held
              .slice(0, reception.length ?? reception.fragmentCount * reception.fragmentSize)
              .filter((held) => !held).length,
      fragment_size: this.#fragmentSize,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Transmission queue

  #isRunActive(): boolean {
    return this.#senderRun !== null || this.#receiverRuns.size > 0;
  }

  /** HELLO messages, fragments and reports wait while a run or `presence off` holds them. */
  #isSuspended(): boolean {
    return this.#holdSeconds !== null || this.#isRunActive();
  }

  #enqueue(transmission: QueuedTransmission): void {
    this.#queue.push(transmission);
    this.#pump();
  }

  #pump(): void {
    if (this.#transmitting || this.#pumpScheduled || this.#nextTransmissionIndex() === -1) {
      return;
    }
    this.#pumpScheduled = true;
    this.network.schedule(() => {
      this.#pumpScheduled = false;
      const index = this.#nextTransmissionIndex();
      if (this.#transmitting || index === -1) {
        return;
      }
      const transmission = this.#queue.splice(index, 1)[0]!;
      const built = transmission.build();
      if (built === null) {
        this.#pump();
        return;
      }
      this.#transmit(transmission, built.destination, built.body);
    }, SIMULATED_PACKET_GAP_MILLISECONDS);
  }

  #nextTransmissionIndex(): number {
    const suspended = this.#isSuspended();
    return this.#queue.findIndex(
      (transmission) =>
        !suspended ||
        (transmission.type !== "hello" &&
          transmission.type !== "fragment" &&
          transmission.type !== "report"),
    );
  }

  #transmit(
    transmission: QueuedTransmission,
    destination: NodeIdentifier,
    body: SimulatedFrameBody,
  ): void {
    if (transmission.sequence === undefined) {
      this.#sequence += 1;
    }
    const frame: SimulatedFrame = {
      source: this.identifier,
      epoch: this.#epoch,
      sequence: transmission.sequence ?? this.#sequence,
      destination,
      channel: {
        freq: this.#radio.freq,
        sf: this.#radio.sf,
        bw: this.#radio.bw,
        cr: this.#radio.cr,
      },
      body,
    };
    this.#lastFrame = { type: transmission.type, destination, body, sequence: frame.sequence };
    this.#transmitting = true;
    const startHostTime = this.#timeSource.now();
    const frameLength = computeFrameLength(bodyLengthOf(body));
    const timeOnAir = computeTimeOnAirMicroseconds(frameLength, this.#radio);
    transmission.onStart?.(frame, startHostTime);
    this.network.schedule(() => {
      const endHostTime = startHostTime + timeOnAir / 1000;
      this.#transmitting = false;
      this.#sentCount += 1;
      this.#emit("tx", {
        type: transmission.type,
        dst: destination,
        seq: frame.sequence,
        size: frameLength,
        toa: timeOnAir,
        toa_calc: timeOnAir,
        ...transmissionFields(body),
      });
      this.network.broadcast(this, frame);
      transmission.onEnd?.(frame, endHostTime);
      this.#pump();
    }, timeOnAir / 1000);
  }

  #timeOnAirMicroseconds(frame: SimulatedFrame): number {
    return computeTimeOnAirMicroseconds(computeFrameLength(bodyLengthOf(frame.body)), this.#radio);
  }

  /** The time on air of a frame of `bodyLength` bytes with the current settings, in ms. */
  #timeOnAirOfBody(bodyLength: number): number {
    return computeTimeOnAirMicroseconds(computeFrameLength(bodyLength), this.#radio) / 1000;
  }

  /** Called when a suspension ends: the held frames and the held reports go out. */
  #resume(): void {
    if (this.#isSuspended()) {
      return;
    }
    this.#pump();
    const reception = this.#imageReception;
    if (reception !== null && reception.reportHeld) {
      reception.reportHeld = false;
      this.#reportMissing(reception);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Presence and neighbors

  #announcedState(): AnnouncedState {
    return {
      model: this.model,
      version: this.#activeVersion,
      available: this.#availableVersion,
      vmFault: this.#faultSinceActivation,
      vmFailing: this.#faultedSinceHello,
      transmitted: this.#sentCount,
    };
  }

  #endHold(): void {
    this.#cancelHold();
    this.#cancelHold = () => {};
    this.#holdSeconds = null;
    this.#resume();
  }

  /** The neighbors heard within the expiry, after removing the others. */
  #currentNeighbors(): Neighbor[] {
    const now = this.#timeSource.now();
    for (const [id, neighbor] of this.#neighbors) {
      if (isNeighborExpired(now - neighbor.lastHeardHostTime)) {
        this.#neighbors.delete(id);
      }
    }
    return [...this.#neighbors.values()];
  }

  #isNeighbor(id: NodeIdentifier): boolean {
    return this.#currentNeighbors().some((neighbor) => neighbor.id === id);
  }

  #recordFrame(source: NodeIdentifier, quality: LinkQuality): Neighbor {
    const neighbors = this.#currentNeighbors();
    let neighbor = this.#neighbors.get(source);
    if (neighbor === undefined) {
      if (neighbors.length >= MAXIMUM_NEIGHBORS) {
        const oldest = neighbors.reduce((first, second) =>
          first.lastHeardHostTime <= second.lastHeardHostTime ? first : second,
        );
        this.#neighbors.delete(oldest.id);
      }
      neighbor = { id: source, announced: null, rssi: 0, snr: 0, lastHeardHostTime: 0 };
      this.#neighbors.set(source, neighbor);
    }
    neighbor.rssi = quality.rssi;
    neighbor.snr = quality.snr;
    neighbor.lastHeardHostTime = this.#timeSource.now();
    return neighbor;
  }

  #receiveHello(
    frame: SimulatedFrame,
    body: Extract<SimulatedFrameBody, { type: "hello" }>,
    quality: LinkQuality,
  ): void {
    const neighbor = this.#neighbors.get(frame.source);
    if (neighbor !== undefined) {
      neighbor.announced = body.announced;
    }
    const announced = body.announced;
    this.#emit("hello", {
      src: frame.source,
      epoch: frame.epoch,
      seq: frame.sequence,
      model: announced.model,
      version: announced.version,
      available: announced.available,
      vm_fault: announced.vmFault,
      vm_failing: announced.vmFailing,
      tx: announced.transmitted,
      ...this.#linkFields(quality),
      ferr: Math.round(quality.frequencyError),
      neighbors: body.neighbors.map((entry) => ({ ...entry })),
    });
    this.#emitLine(`hello ${frame.source} ${Math.round(quality.rssi)} dBm`);
    if (
      announced.version === this.#availableVersion &&
      this.#availableVersion > this.#activeVersion
    ) {
      this.#activate("hello", frame.source);
    }
    if (
      announced.available < this.#availableVersion &&
      this.#availableImage !== null &&
      !this.#hasBurstOf(this.#availableVersion)
    ) {
      this.#requestBurst("hello", frame.source, null, this.#fragmentSize);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Echo

  #receiveEchoRequest(
    frame: SimulatedFrame,
    body: Extract<SimulatedFrameBody, { type: "echo_request" }>,
    quality: LinkQuality,
  ): void {
    if (frame.destination !== this.identifier) {
      return;
    }
    const link = this.#linkFields(quality);
    this.#enqueue({
      type: "echo_reply",
      build: () => ({
        destination: frame.source,
        body: { type: "echo_reply", number: body.number, size: body.size, ...link },
      }),
      onStart: () => {
        this.#emit("echo_served", { src: frame.source, n: body.number, size: body.size, ...link });
      },
    });
  }

  #receiveEchoReply(
    frame: SimulatedFrame,
    body: Extract<SimulatedFrameBody, { type: "echo_reply" }>,
    quality: LinkQuality,
  ): void {
    const echo = this.#pendingEcho;
    if (
      echo === null ||
      echo.startHostTime === null ||
      frame.source !== echo.destination ||
      body.number !== echo.number
    ) {
      return;
    }
    echo.cancelTimeout();
    this.#pendingEcho = null;
    const roundTrip = Math.round((this.#timeSource.now() - echo.startHostTime) * 1000);
    this.#emit("echo", {
      dst: frame.source,
      n: body.number,
      size: body.size,
      rtt: roundTrip,
      ...this.#linkFields(quality),
      remote_rssi: body.rssi,
      remote_snr: body.snr,
    });
    this.#emitLine(`echo ${frame.source} ${(roundTrip / 1000).toFixed(1)} ms`);
  }

  // -------------------------------------------------------------------------------------------
  // Runs

  #transmitNextTestPacket(): void {
    const run = this.#senderRun;
    if (
      run === null ||
      run.held ||
      run.stopRequested ||
      run.frameInFlight ||
      run.sent >= run.count
    ) {
      return;
    }
    run.frameInFlight = true;
    this.#enqueue({
      type: "test",
      build: () => ({
        destination: BROADCAST_IDENTIFIER,
        body: {
          type: "test",
          run: run.run,
          index: run.sent,
          count: run.count,
          size: run.size,
          interval: run.interval,
        },
      }),
      onStart: (_frame, startHostTime) => {
        run.firstStartHostTime ??= startHostTime;
      },
      onEnd: (_frame, endHostTime) => {
        run.frameInFlight = false;
        run.sent += 1;
        run.lastEndHostTime = endHostTime;
        if (!this.#finishSendingIfOver()) {
          this.network.schedule(() => this.#transmitNextTestPacket(), run.interval);
        }
      },
    });
  }

  /** Ends the run once every packet went out, or after a stop; true when it ended. */
  #finishSendingIfOver(): boolean {
    const run = this.#senderRun;
    if (run === null || run.frameInFlight || (!run.stopRequested && run.sent < run.count)) {
      return false;
    }
    const duration =
      run.firstStartHostTime === null || run.lastEndHostTime === null
        ? 0
        : Math.round((run.lastEndHostTime - run.firstStartHostTime) * 1000);
    this.#emit("run_done", {
      run: run.run,
      count: run.count,
      sent: run.sent,
      duration,
      aborted: run.stopRequested,
    });
    this.#emitLine(`run ${run.run} done ${run.sent}/${run.count}`);
    this.#senderRun = null;
    this.#resume();
    return true;
  }

  #receiveTestPacket(
    frame: SimulatedFrame,
    body: Extract<SimulatedFrameBody, { type: "test" }>,
    quality: LinkQuality,
  ): void {
    const now = this.#nodeTime();
    let run = this.#receiverRuns.get(frame.source);
    if (run !== undefined && run.run !== body.run) {
      this.#finishReceiving(run, "timeout");
      run = undefined;
    }
    const opened = run === undefined;
    if (run === undefined) {
      run = {
        source: frame.source,
        run: body.run,
        count: body.count,
        received: 0,
        rssiSum: 0,
        snrSum: 0,
        rssiMinimum: quality.rssi,
        rssiMaximum: quality.rssi,
        first: now,
        last: now,
        cancelDeadline: () => {},
      };
      this.#receiverRuns.set(frame.source, run);
    }
    const reception = run;
    reception.received += 1;
    reception.rssiSum += quality.rssi;
    reception.snrSum += quality.snr;
    reception.rssiMinimum = Math.min(reception.rssiMinimum, quality.rssi);
    reception.rssiMaximum = Math.max(reception.rssiMaximum, quality.rssi);
    reception.last = now;
    reception.cancelDeadline();
    const deadline = runReceptionDeadlineMilliseconds(
      body.interval,
      this.#timeOnAirMicroseconds(frame),
    );
    reception.cancelDeadline = this.network.schedule(
      () => this.#finishReceiving(reception, "timeout"),
      deadline,
    );
    this.#emit("test_rx", {
      src: frame.source,
      run: body.run,
      index: body.index,
      count: body.count,
      size: body.size,
      ...this.#linkFields(quality),
      ferr: Math.round(quality.frequencyError),
    });
    if (opened) {
      this.#emitLine(`run ${body.run} from ${frame.source}`);
    }
    if (body.index + 1 >= body.count) {
      this.#finishReceiving(reception, "complete");
    }
  }

  #finishReceiving(run: ReceiverRun, reason: "complete" | "timeout"): void {
    run.cancelDeadline();
    this.#receiverRuns.delete(run.source);
    if (this.behavior.omitsRunEnd !== true) {
      this.#emit("run_end", {
        src: run.source,
        run: run.run,
        count: run.count,
        received: run.received,
        pdr: roundTo(run.received / run.count, PACKET_DELIVERY_RATIO_DECIMALS),
        rssi_avg: roundTo(run.rssiSum / run.received, RSSI_DECIMALS),
        rssi_min: roundTo(run.rssiMinimum, RSSI_DECIMALS),
        rssi_max: roundTo(run.rssiMaximum, RSSI_DECIMALS),
        snr_avg: roundTo(run.snrSum / run.received, SNR_DECIMALS),
        first: run.first,
        last: run.last,
        reason,
      });
      this.#emitLine(`run ${run.run} end ${run.received}/${run.count}`);
    }
    this.#resume();
  }

  // -------------------------------------------------------------------------------------------
  // Image transfer

  #hasBurstOf(version: number): boolean {
    return (
      this.#currentBurst?.version === version ||
      this.#bursts.some((burst) => burst.version === version)
    );
  }

  /**
   * Asks for a broadcast burst of the available image: every fragment, or those of `indices`, of
   * `size` bytes. A report for a burst of the same version and size still waiting or in progress
   * adds its fragments to it.
   */
  #requestBurst(
    cause: BurstCause,
    trigger: NodeIdentifier | null,
    indices: readonly number[] | null,
    size: number,
  ): void {
    const image = this.#availableImage;
    if (image === null) {
      return;
    }
    const count = Math.ceil(image.length / size);
    const wanted = (indices ?? Array.from({ length: count }, (_, index) => index)).filter(
      (index) => index < count,
    );
    const joined =
      cause === "report"
        ? [this.#currentBurst, ...this.#bursts].find(
            (burst) =>
              burst !== null && burst.version === this.#availableVersion && burst.size === size,
          )
        : undefined;
    if (joined !== undefined && joined !== null) {
      for (const index of wanted) {
        if (!joined.indices.includes(index)) {
          joined.indices.push(index);
        }
      }
      return;
    }
    this.#bursts.push({
      version: this.#availableVersion,
      size,
      cause,
      trigger,
      indices: [...wanted],
      sent: 0,
      startHostTime: null,
    });
    this.#startNextBurst();
  }

  #startNextBurst(): void {
    if (this.#currentBurst !== null) {
      return;
    }
    const burst = this.#bursts.shift();
    if (burst === undefined) {
      return;
    }
    this.#currentBurst = burst;
    this.#emit("burst_start", {
      version: burst.version,
      size: burst.size,
      count: burst.indices.length,
      cause: burst.cause,
      trigger: burst.trigger,
    });
    this.#sendNextFragment(burst);
  }

  #sendNextFragment(burst: Burst): void {
    this.#enqueue({
      type: "fragment",
      build: () => {
        const image = this.#availableImage;
        const index = burst.indices.shift();
        if (this.#currentBurst !== burst || image === null || index === undefined) {
          return null;
        }
        return {
          destination: BROADCAST_IDENTIFIER,
          body: {
            type: "fragment",
            version: burst.version,
            index,
            count: Math.ceil(image.length / burst.size),
            size: burst.size,
            remaining: burst.indices.length,
            data: image.slice(index * burst.size, (index + 1) * burst.size),
          },
        };
      },
      onStart: (_frame, startHostTime) => {
        burst.startHostTime ??= startHostTime;
      },
      onEnd: (_frame, endHostTime) => {
        burst.sent += 1;
        if (burst.indices.length > 0) {
          this.#sendNextFragment(burst);
        } else {
          this.#finishBurst(burst, endHostTime);
        }
      },
    });
  }

  #finishBurst(burst: Burst, endHostTime: number): void {
    if (this.#currentBurst !== burst) {
      return;
    }
    this.#currentBurst = null;
    this.#emit("burst_done", {
      version: burst.version,
      size: burst.size,
      sent: burst.sent,
      duration:
        burst.startHostTime === null ? 0 : Math.round((endHostTime - burst.startHostTime) * 1000),
    });
    this.#startNextBurst();
  }

  /** The image becomes the available one; the bursts of the previous one end here. */
  #installImage(
    bytes: Uint8Array,
    arrival: "console" | "radio",
    source: NodeIdentifier | null,
    fragments: number,
    reports: number,
    duration: number,
  ): void {
    const decoding = decodeImage(bytes);
    if (!decoding.valid) {
      return;
    }
    const current = this.#currentBurst;
    if (current !== null) {
      this.#finishBurst(current, this.#timeSource.now());
    }
    this.#bursts.length = 0;
    this.#availableImage = bytes.slice();
    this.#availableVersion = decoding.image.version;
    if (this.#imageReception !== null && this.#imageReception.version <= this.#availableVersion) {
      this.#imageReception.cancelDeadline();
      this.#imageReception = null;
    }
    this.#emit("image", {
      version: decoding.image.version,
      size: decoding.image.programLength,
      image_size: bytes.length,
      via: arrival,
      src: source,
      fragments,
      reports,
      duration,
    });
    this.sendHello();
    this.#requestBurst(arrival === "radio" ? "complete" : "load", null, null, this.#fragmentSize);
    this.#emitLine(`image v${decoding.image.version} ${arrival}`);
  }

  #receiveFragment(
    frame: SimulatedFrame,
    body: Extract<SimulatedFrameBody, { type: "fragment" }>,
    quality: LinkQuality,
  ): void {
    let reception = this.#imageReception;
    const accepted =
      body.version > this.#availableVersion &&
      (reception === null || body.version >= reception.version);
    let brought = false;
    if (accepted) {
      if (reception === null || reception.version !== body.version) {
        reception?.cancelDeadline();
        reception = {
          version: body.version,
          bytes: new Uint8Array(MAXIMUM_IMAGE_SIZE),
          held: Array.from({ length: MAXIMUM_IMAGE_SIZE }, () => false),
          length: null,
          fragmentSize: body.size,
          fragmentCount: body.count,
          source: frame.source,
          fragments: 0,
          reports: 0,
          startNodeTime: this.#nodeTime(),
          cancelDeadline: () => {},
          waitsForSource: false,
          reportHeld: false,
        };
        this.#imageReception = reception;
      }
      const offset = body.index * body.size;
      body.data.forEach((byte, position) => {
        if (!reception!.held[offset + position]) {
          brought = true;
          reception!.held[offset + position] = true;
          reception!.bytes[offset + position] = byte;
        }
      });
      if (body.index === body.count - 1) {
        reception.length = offset + body.data.length;
      }
      reception.fragmentSize = body.size;
      reception.fragmentCount = body.count;
      reception.source = frame.source;
      reception.fragments += 1;
    }
    this.#emit("fragment_rx", {
      src: frame.source,
      version: body.version,
      index: body.index,
      count: body.count,
      size: body.size,
      remaining: body.remaining,
      accepted,
      new: brought,
      ...this.#linkFields(quality),
    });
    if (!accepted || reception === null) {
      return;
    }
    if (this.#missingFragments(reception).length === 0 && reception.length !== null) {
      this.#completeReception(reception);
      return;
    }
    // The burst of the sender ends after the remaining fragments; the receiver reports then.
    const target = reception;
    target.cancelDeadline();
    if (body.remaining === 0) {
      this.#reportMissing(target);
      return;
    }
    const burstEnd =
      body.remaining * this.#timeOnAirOfBody(FRAGMENT_HEADER_SIZE + body.size) +
      TRANSFER_MARGIN_MILLISECONDS;
    target.cancelDeadline = this.network.schedule(() => this.#reportMissing(target), burstEnd);
  }

  /** Missing fragments of the reception, counted with the size of its last fragment. */
  #missingFragments(reception: ImageReception): number[] {
    const missing: number[] = [];
    for (let index = 0; index < reception.fragmentCount; ++index) {
      const start = index * reception.fragmentSize;
      const end =
        reception.length === null
          ? start + reception.fragmentSize
          : Math.min(start + reception.fragmentSize, reception.length);
      if (
        (reception.length === null && index === reception.fragmentCount - 1) ||
        reception.held.slice(start, end).some((held) => !held)
      ) {
        missing.push(index);
      }
    }
    return missing;
  }

  /**
   * Reports the missing fragments to the sender of the last one and repeats the report while no
   * fragment of the version arrives. The receiver stops while that sender is out of its neighbor
   * table, and starts again when it hears the sender.
   */
  #reportMissing(reception: ImageReception): void {
    reception.cancelDeadline();
    if (this.#imageReception !== reception) {
      return;
    }
    if (this.#isSuspended()) {
      reception.reportHeld = true;
      return;
    }
    if (!this.#isNeighbor(reception.source)) {
      reception.waitsForSource = true;
      return;
    }
    const missing = this.#missingFragments(reception);
    reception.reports += 1;
    this.#emit("report_sent", {
      dst: reception.source,
      version: reception.version,
      size: reception.fragmentSize,
      count: reception.fragmentCount,
      missing,
      round: reception.reports,
    });
    this.#enqueue({
      type: "report",
      build: () => ({
        destination: reception.source,
        body: {
          type: "report",
          version: reception.version,
          size: reception.fragmentSize,
          count: reception.fragmentCount,
          missing,
        },
      }),
      onEnd: () => {
        if (this.#imageReception !== reception) {
          return;
        }
        const repetition =
          this.#timeOnAirOfBody(reportBodyLength(reception.fragmentCount)) +
          this.#timeOnAirOfBody(FRAGMENT_HEADER_SIZE + reception.fragmentSize) +
          TRANSFER_MARGIN_MILLISECONDS;
        reception.cancelDeadline = this.network.schedule(
          () => this.#reportMissing(reception),
          repetition,
        );
      },
    });
  }

  #receiveReport(
    frame: SimulatedFrame,
    body: Extract<SimulatedFrameBody, { type: "report" }>,
  ): void {
    if (frame.destination !== this.identifier) {
      return;
    }
    this.#emit("report_received", {
      src: frame.source,
      version: body.version,
      size: body.size,
      count: body.count,
      missing: body.missing,
    });
    if (body.version === this.#availableVersion) {
      this.#requestBurst("report", frame.source, body.missing, body.size);
    }
  }

  #completeReception(reception: ImageReception): void {
    reception.cancelDeadline();
    const length = reception.length ?? 0;
    const bytes = reception.bytes.slice(0, length);
    this.#imageReception = null;
    const decoding = decodeImage(bytes);
    if (!decoding.valid) {
      this.#emit("image_rejected", {
        version: reception.version,
        reason: decoding.reason,
        src: reception.source,
      });
      this.#emitLine(`image v${reception.version} ${decoding.reason}`);
      return;
    }
    this.#installImage(
      bytes,
      "radio",
      reception.source,
      reception.fragments,
      reception.reports,
      this.#nodeTime() - reception.startNodeTime,
    );
    const announcer = this.#currentNeighbors().find(
      (neighbor) => neighbor.announced?.version === reception.version,
    );
    if (announcer !== undefined && reception.version > this.#activeVersion) {
      this.#activate("neighbor", announcer.id);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Activation and VM

  /** Activates the available version and starts its program at once, as the firmware does. */
  #activate(cause: ActivationCause, source: NodeIdentifier | null): void {
    const image = this.#availableImage;
    const decoding = image === null ? null : decodeImage(image);
    if (decoding === null || !decoding.valid) {
      return;
    }
    const previous = this.#activeVersion;
    this.#activeVersion = decoding.image.version;
    this.#program = decoding.image.program;
    this.#cancelProgram();
    this.#machine.load(this.#program);
    this.#faultSinceActivation = null;
    this.#faultedSinceHello = false;
    this.#emit("activation", { version: this.#activeVersion, previous, cause, src: source });
    this.#emitVirtualMachine();
    this.#emitLine(`VM: program v${this.#activeVersion}`);
    this.sendHello();
    this.#runProgram();
  }

  /** Runs the rest of the program later. A wait of the program itself is work for settle(). */
  #continueProgram(delayMilliseconds: number, isWork: boolean): void {
    this.#cancelProgram();
    this.#cancelProgram = this.network.schedule(
      () => this.#runProgram(),
      delayMilliseconds,
      isWork,
    );
  }

  /**
   * Runs the program in blocks, as the firmware does, up to its next wait: the one after a PRINT,
   * a SLEEP or the restart after HALT or a fault. A program that never waits yields after
   * MAXIMUM_PROGRAM_BLOCKS and goes on a moment later, so that the simulation keeps moving.
   */
  #runProgram(): void {
    if (this.#program.length === 0) {
      return;
    }
    if (!this.#machine.isRunning) {
      this.#machine.startVM();
    }
    for (let block = 0; block < MAXIMUM_PROGRAM_BLOCKS; block += 1) {
      const { step, print } = advance(this.#machine, VM_INSTRUCTIONS_PER_POLL);
      switch (step) {
        case "printed":
          if (print !== null) {
            this.#emit("vm_print", { n: print.number, reg: print.register, value: print.value });
            this.#emitLine(formatPrintLine(print.register, print.value));
          }
          this.#continueProgram(VM_MINIMUM_PRINT_INTERVAL_MILLISECONDS, true);
          return;
        case "sleeping":
          this.#continueProgram(this.#machine.sleepMilliseconds, true);
          return;
        case "halted":
          this.#emitLine("VM: HALT stop-reset");
          this.#continueProgram(VM_RESTART_DELAY_MILLISECONDS, false);
          return;
        case "faulted": {
          const fault = this.#machine.fault;
          if (fault !== null) {
            this.#faultSinceActivation = fault;
            this.#faultedSinceHello = true;
            this.#emit("vm_fault", {
              starts: this.#machine.startCount,
              pc: this.#machine.faultAddress,
              reason: fault,
            });
            this.#emitLine(`VM: ${fault}`);
          }
          this.#continueProgram(VM_RESTART_DELAY_MILLISECONDS, false);
          return;
        }
        case "idle":
          return;
        case "running":
          break;
      }
    }
    this.#continueProgram(1, false);
  }
}

function reportBodyLength(fragmentCount: number): number {
  return REPORT_FIXED_SIZE + Math.ceil(fragmentCount / 8);
}

function bodyLengthOf(body: SimulatedFrameBody): number {
  switch (body.type) {
    case "hello":
      return HELLO_FIXED_SIZE + HELLO_NEIGHBOR_SIZE * body.neighbors.length;
    case "echo_request":
    case "echo_reply":
    case "test":
      return body.size;
    case "fragment":
      return FRAGMENT_HEADER_SIZE + body.data.length;
    case "report":
      return reportBodyLength(body.count);
  }
}

/** The fields of the `tx` event that only some types carry. */
function transmissionFields(body: SimulatedFrameBody): Record<string, number> {
  switch (body.type) {
    case "test":
      return { run: body.run, index: body.index };
    case "fragment":
      return { version: body.version, index: body.index };
    case "report":
      return { version: body.version };
    default:
      return {};
  }
}

/** A sender and a receiver that hear each other. */
export function createSimulatedPair(
  clock: TimeSource,
  senderBehavior: SimulatedNodeBehavior = {},
  receiverBehavior: SimulatedNodeBehavior = {},
): { sender: SimulatedNode; receiver: SimulatedNode } {
  const network = new SimulatedNetwork(clock);
  const sender = new SimulatedNode("5C21", "V2", clock, senderBehavior, network);
  const receiver = new SimulatedNode("3A7F", "V4.3", clock, receiverBehavior, network);
  return { sender, receiver };
}

/**
 * A node simulated for the tests: it answers console commands with the lines the firmware would
 * write (docs/protocol/console.md, contract version 2) and delivers them through the console
 * parser. Two simulated nodes linked as peers exchange TEST, HELLO, FRAGMENT and REPORT packets
 * instantly; the manual clock advances with the time on air of each packet.
 *
 * The image transfer follows docs/protocol/frame.md with two simplifications: a receiver checks
 * the format and the program of an image it completes over the radio but not its signature, since
 * the simulated radio delivers the verified bytes of its peer; and the receiver reports, or
 * completes the image, once the burst of its peer ends rather than with each fragment.
 */
import type { CampaignNode } from "$lib/measurements/capacity-test-campaign.ts";
import type {
  BoardModel,
  BurstCause,
  ConsoleEvent,
  NodeIdentifier,
} from "$lib/console/console-event.ts";
import { parseConsoleLine } from "$lib/console/console-line-parser.ts";
import {
  DEFAULT_FRAGMENT_SIZE,
  MAXIMUM_FRAGMENT_SIZE,
  MINIMUM_FRAGMENT_SIZE,
} from "$lib/console/console-command.ts";
import { decodeImage, formatHex, parseHex } from "$lib/image/image-format.ts";
import { DEFAULT_OPERATOR_PUBLIC_KEY, verifyImage } from "$lib/image/image-signing.ts";
import { DEFAULT_RADIO_SETTINGS, timeOnAirFor } from "$lib/radio/radio-settings.ts";
import { computeFrameLength } from "$lib/radio/time-on-air.ts";
import type { ManualTimeSource } from "$lib/utils/time-source.ts";
import { VirtualMachine, runTick, type VmFault } from "$lib/vm/virtual-machine.ts";

export interface SimulatedNodeBehavior {
  /** Packets of a run this node, as receiver, does not hear. */
  readonly losesPacket?: (run: number, index: number) => boolean;
  /** Refuses the next `radio` commands with this reason. */
  readonly radioRefusal?: { readonly reason: string; readonly times: number };
  /** Never answers `radio` with arguments. */
  readonly ignoresRadio?: boolean;
  /** As receiver, never reports `run_end`. */
  readonly omitsRunEnd?: boolean;
  /** As sender, announces the run and waits for `releaseRun()` before transmitting it. */
  readonly holdsRun?: boolean;
  /** Echo requests from another node that this node does not hear. */
  readonly losesEchoRequest?: (number: number) => boolean;
  /** Refuses `presence` with this reason. */
  readonly presenceRefusal?: string;
  /**
   * Fragments from another node that this node does not hear; `delivery` counts, from 1, the
   * times that fragment index of that version reached the node.
   */
  readonly losesFragment?: (version: number, index: number, delivery: number) => boolean;
  /** Public key the node verifies images with; the default pair by default. */
  readonly operatorPublicKey?: string;
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
}

interface NeighborAnnouncement {
  readonly model: BoardModel;
  readonly active: number;
  readonly available: number;
  readonly transmitted: number;
  readonly hostTime: number;
}

/** The firmware never sends more reports than this in the simulation, to end a lossy loop. */
const MAXIMUM_SIMULATED_REPORTS = 20;
const IMAGE_BUFFER_SIZE = 1097;
/** Offset of the version in the image header (docs/protocol/image.md). */
const IMAGE_VERSION_OFFSET = 3;
const HELLO_BODY_SIZE = 15;
const HELLO_NEIGHBOR_SIZE = 4;
const FRAGMENT_HEADER_SIZE = 8;
const REPORT_HEADER_SIZE = 6;

interface RadioState {
  freq: number;
  sf: number;
  bw: number;
  cr: number;
  preamble: number;
  sync: number;
  power: number;
}

interface PendingRun {
  readonly run: number;
  readonly count: number;
  readonly size: number;
}

interface ReceptionTally {
  received: number;
  rssiSum: number;
  snrSum: number;
  rssiMinimum: number;
  rssiMaximum: number;
  first: number;
  last: number;
}

/** Time between packets beyond their time on air, below the estimate of the plan. */
const PACKET_GAP_MILLISECONDS = 2;

export class SimulatedNode implements CampaignNode {
  readonly identifier: NodeIdentifier;
  readonly model: BoardModel;
  readonly commands: string[] = [];
  readonly emittedLines: string[] = [];
  peer: SimulatedNode | null = null;
  behavior: SimulatedNodeBehavior;
  readonly #clock: ManualTimeSource;
  readonly #bootHostTime: number;
  readonly #listeners = new Set<(event: ConsoleEvent, hostTime: number) => void>();
  readonly #radio: RadioState = {
    freq: DEFAULT_RADIO_SETTINGS.freq,
    sf: DEFAULT_RADIO_SETTINGS.sf,
    bw: DEFAULT_RADIO_SETTINGS.bw,
    cr: DEFAULT_RADIO_SETTINGS.cr,
    preamble: DEFAULT_RADIO_SETTINGS.preamble,
    sync: DEFAULT_RADIO_SETTINGS.sync,
    power: DEFAULT_RADIO_SETTINGS.power,
  };
  #radioRefusalsLeft: number;
  #runCounter = 0;
  #sequence = 0;
  #heldRun: PendingRun | null = null;
  #echoCounter = 0;
  /** Seconds of the HELLO hold in course; null while the HELLO messages are on. */
  presenceHoldSeconds: number | null = null;
  #stopRequested = false;
  readonly #receptions = new Map<string, ReceptionTally>();
  #activeVersion = 0;
  #availableVersion = 0;
  #availableImage: Uint8Array | null = null;
  #fragmentSize = DEFAULT_FRAGMENT_SIZE;
  #imageReception: ImageReception | null = null;
  readonly #fragmentDeliveries = new Map<string, number>();
  readonly #neighbors = new Map<NodeIdentifier, NeighborAnnouncement>();
  readonly #machine = new VirtualMachine();
  #program: Uint8Array = new Uint8Array(0);
  #faultSinceActivation: VmFault | null = null;
  #lastTickFailed = false;
  /** Asynchronous work in progress, such as the verification of a loaded image. */
  #pendingWork: Promise<void> = Promise.resolve();

  constructor(
    identifier: NodeIdentifier,
    model: BoardModel,
    clock: ManualTimeSource,
    behavior: SimulatedNodeBehavior = {},
  ) {
    this.identifier = identifier;
    this.model = model;
    this.#clock = clock;
    this.#bootHostTime = clock.now() - 1000;
    this.behavior = behavior;
    this.#radioRefusalsLeft = behavior.radioRefusal?.times ?? 0;
  }

  sendCommand(command: string): Promise<void> {
    this.commands.push(command);
    queueMicrotask(() => this.#execute(command));
    return Promise.resolve();
  }

  subscribe(listener: (event: ConsoleEvent, hostTime: number) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Current modulation, to check what a test left behind. */
  get modulation(): { readonly sf: number; readonly bw: number; readonly cr: number } {
    return { sf: this.#radio.sf, bw: this.#radio.bw, cr: this.#radio.cr };
  }

  /** Active and available versions, to check the outcome of an update. */
  get versions(): { readonly active: number; readonly available: number } {
    return { active: this.#activeVersion, available: this.#availableVersion };
  }

  /** Resolves once the commands sent so far, including asynchronous ones, have been executed. */
  async settle(): Promise<void> {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    let pending: Promise<void>;
    do {
      pending = this.#pendingWork;
      await pending;
    } while (pending !== this.#pendingWork);
  }

  /** Transmits a HELLO now, as the periodic timer of the firmware would. */
  sendHello(): void {
    if (this.presenceHoldSeconds !== null) {
      return;
    }
    const neighbors = [...this.#neighbors.keys()];
    const helloTransmitted = this.#sequence;
    this.#transmitFrame("hello", "FFFF", HELLO_BODY_SIZE + HELLO_NEIGHBOR_SIZE * neighbors.length);
    const peer = this.peer;
    if (peer !== null) {
      peer.#receiveHello(this, helloTransmitted);
    }
  }

  /** Transmits a run held by the `holdsRun` behavior. */
  releaseRun(): void {
    const run = this.#heldRun;
    this.#heldRun = null;
    if (run !== null) {
      this.#transmitRun(run);
    }
  }

  #nodeTime(): number {
    return this.#clock.now() - this.#bootHostTime;
  }

  #emitLine(line: string): void {
    this.emittedLines.push(line);
    const parsed = parseConsoleLine(line);
    if (parsed.kind !== "event") {
      return;
    }
    for (const listener of this.#listeners) {
      listener(parsed.event, this.#clock.now());
    }
  }

  #emitEvent(name: string, fields: string): void {
    this.#emitLine(`{"t":${this.#nodeTime()},"ev":"${name}"${fields === "" ? "" : `,${fields}`}}`);
  }

  #emitError(command: string, reason: string, detail?: string): void {
    this.#emitEvent(
      "error",
      `"cmd":"${command}","reason":"${reason}"${detail === undefined ? "" : `,"detail":"${detail}"`}`,
    );
    this.#emitLine(`error ${command} ${reason}`);
  }

  #emitRadio(): void {
    const radio = this.#radio;
    const lna = this.model === "V4.3" ? '"bypass"' : "null";
    const chip = this.model === "V4.3" ? radio.power - 13 : radio.power;
    this.#emitEvent(
      "radio",
      `"freq":${radio.freq.toFixed(3)},"sf":${radio.sf},"bw":${radio.bw},"cr":${radio.cr},"preamble":${radio.preamble},"sync":${radio.sync},"power":${radio.power},"chip":${chip},"lna":${lna}`,
    );
  }

  #execute(command: string): void {
    const words = command.trim().split(/\s+/);
    switch (words[0]) {
      case "radio":
        this.#executeRadio(words.slice(1));
        break;
      case "run":
        this.#executeRun(words.slice(1));
        break;
      case "echo":
        this.#executeEcho(words.slice(1));
        break;
      case "presence":
        this.#executePresence(words.slice(1));
        break;
      case "status":
        this.#executeStatus();
        break;
      case "load_image":
        this.#executeLoadImage(words.slice(1));
        break;
      case "activate":
        this.#executeActivate(words.slice(1));
        break;
      case "fragment_size":
        this.#executeFragmentSize(words.slice(1));
        break;
      case "program":
        this.#emitEvent(
          "program",
          `"version":${this.#activeVersion},"size":${this.#program.length},"code":"${formatHex(this.#program)}"`,
        );
        break;
      case "load_registers":
        this.#machine.setRegisters(words.slice(1).map(Number));
        this.#emitVirtualMachine();
        break;
      default:
        this.#emitError(words[0] ?? "", "unknown_command");
    }
  }

  #emitVirtualMachine(): void {
    this.#emitEvent(
      "vm",
      `"version":${this.#activeVersion},"size":${this.#program.length},"tick":${this.#machine.tickNumber},"registers":[${this.#machine.registers.join(",")}]`,
    );
  }

  #emitTransfer(): void {
    const reception = this.#imageReception;
    const missing =
      reception === null
        ? "null"
        : String(
            reception.held
              .slice(0, reception.length ?? reception.fragmentCount * reception.fragmentSize)
              .filter((held) => !held).length,
          );
    this.#emitEvent(
      "transfer",
      `"active":${this.#activeVersion},"available":${this.#availableVersion},"receiving":${reception?.version ?? "null"},"missing":${missing},"fragment_size":${this.#fragmentSize}`,
    );
  }

  #vmFields(): string {
    return `"vm_fault":${this.#faultSinceActivation === null ? "null" : `"${this.#faultSinceActivation}"`},"vm_failing":${this.#lastTickFailed}`;
  }

  #executeStatus(): void {
    this.#emitEvent(
      "status",
      `"id":"${this.identifier}","model":"${this.model}","epoch":1,"tx":${this.#sequence},"rx":0,"dropped":0,"heap":200000`,
    );
    this.#emitRadio();
    this.#emitEvent("wifi", `"state":"off","ssid":"J5-${this.identifier}","channel":1,"clients":0`);
    this.#emitEvent(
      "presence",
      this.presenceHoldSeconds === null
        ? `"state":"on","remaining":null`
        : `"state":"off","remaining":${this.presenceHoldSeconds}`,
    );
    this.#emitVirtualMachine();
    this.#emitTransfer();
    const now = this.#clock.now();
    for (const [id, neighbor] of this.#neighbors) {
      this.#emitEvent(
        "neighbor",
        `"id":"${id}","model":"${neighbor.model}","version":${neighbor.active},"available":${neighbor.available},"vm_fault":null,"vm_failing":false,"tx":${neighbor.transmitted},"rssi":-55,"snr":8.5,"age":${Math.round(now - neighbor.hostTime)}`,
      );
    }
  }

  #executeLoadImage(argumentsList: readonly string[]): void {
    const hex = argumentsList[0];
    if (hex === undefined || argumentsList.length !== 1) {
      this.#emitError("load_image", "usage", "load_image <image>");
      return;
    }
    const bytes = parseHex(hex);
    if (bytes === null) {
      this.#emitError("load_image", "invalid_image", "format: not hexadecimal");
      return;
    }
    const work = this.#pendingWork.then(async () => {
      // Format first, then version, then signature and program, in the order of the contract.
      const decoding = decodeImage(bytes);
      if (!decoding.valid && decoding.reason === "format") {
        this.#emitError("load_image", "invalid_image", "format");
        return;
      }
      const headerVersion = new DataView(bytes.buffer, bytes.byteOffset).getUint32(
        IMAGE_VERSION_OFFSET,
        true,
      );
      if (headerVersion <= this.#availableVersion) {
        this.#emitError("load_image", "version_not_newer");
        return;
      }
      const verification = await verifyImage(
        bytes,
        this.behavior.operatorPublicKey ?? DEFAULT_OPERATOR_PUBLIC_KEY,
      );
      if (!verification.valid) {
        this.#emitError("load_image", "invalid_image", verification.reason);
        return;
      }
      const { image } = verification;
      this.#acceptImage(bytes);
      this.#emitEvent(
        "image",
        `"version":${image.version},"size":${image.programLength},"image_size":${bytes.length},"via":"console","src":null,"fragments":0,"reports":0,"duration":0`,
      );
      this.#emitLine(`image ${image.version} console`);
      this.sendHello();
      this.#sendBurst("load", null, null, this.#fragmentSize);
    });
    this.#pendingWork = work;
  }

  #acceptImage(bytes: Uint8Array): void {
    const decoding = decodeImage(bytes);
    if (!decoding.valid) {
      return;
    }
    this.#availableImage = bytes.slice();
    this.#availableVersion = decoding.image.version;
    if (this.#imageReception !== null && this.#imageReception.version <= this.#availableVersion) {
      this.#imageReception = null;
    }
  }

  #executeActivate(argumentsList: readonly string[]): void {
    const version = Number(argumentsList[0]);
    if (argumentsList.length !== 1 || !Number.isInteger(version)) {
      this.#emitError("activate", "usage", "activate <version>");
      return;
    }
    if (version !== this.#availableVersion) {
      this.#emitError("activate", "not_available");
      return;
    }
    if (version <= this.#activeVersion) {
      this.#emitError("activate", "version_not_newer");
      return;
    }
    this.#activate("console", null);
  }

  #executeFragmentSize(argumentsList: readonly string[]): void {
    if (argumentsList.length > 0) {
      const size = Number(argumentsList[0]);
      if (!Number.isInteger(size) || size < MINIMUM_FRAGMENT_SIZE || size > MAXIMUM_FRAGMENT_SIZE) {
        this.#emitError("fragment_size", "out_of_range", "fragment_size 32..231");
        return;
      }
      this.#fragmentSize = size;
    }
    this.#emitTransfer();
  }

  /** Activates the available version and runs its first tick, as the firmware does. */
  #activate(cause: "console" | "hello" | "neighbor", source: NodeIdentifier | null): void {
    const image = this.#availableImage;
    const decoding = image === null ? null : decodeImage(image);
    if (decoding === null || !decoding.valid) {
      return;
    }
    const previous = this.#activeVersion;
    this.#activeVersion = decoding.image.version;
    this.#program = decoding.image.program;
    this.#machine.load(this.#program);
    this.#faultSinceActivation = null;
    this.#lastTickFailed = false;
    this.#emitEvent(
      "activation",
      `"version":${this.#activeVersion},"previous":${previous},"cause":"${cause}","src":${source === null ? "null" : `"${source}"`}`,
    );
    this.#emitVirtualMachine();
    this.#emitLine(`activate ${this.#activeVersion}`);
    this.#runTick();
    this.sendHello();
  }

  #runTick(): void {
    const outcome = runTick(this.#machine);
    for (const print of outcome.prints) {
      this.#emitEvent(
        "vm_print",
        `"tick":${print.tick},"reg":${print.register},"value":${print.value}`,
      );
    }
    this.#lastTickFailed = outcome.step === "faulted";
    const fault = this.#machine.fault;
    if (outcome.step === "faulted" && fault !== null) {
      this.#faultSinceActivation = fault;
      this.#emitEvent(
        "vm_fault",
        `"tick":${this.#machine.tickNumber},"pc":${this.#machine.faultAddress},"reason":"${fault}"`,
      );
    }
  }

  /** Transmits one frame of `bodyLength` bytes, advancing the clock by its time on air. */
  #transmitFrame(type: string, destination: NodeIdentifier, bodyLength: number, fields = ""): void {
    const frameLength = computeFrameLength(bodyLength);
    const timeOnAir = timeOnAirFor(frameLength, this.#radio);
    this.#clock.advanceBy(timeOnAir / 1000);
    this.#sequence += 1;
    this.#emitEvent(
      "tx",
      `"type":"${type}","dst":"${destination}","seq":${this.#sequence},"size":${frameLength},"toa":${timeOnAir + 45},"toa_calc":${timeOnAir}${fields}`,
    );
  }

  #receiveHello(sender: SimulatedNode, transmitted: number): void {
    if (!this.#hearsChannel(sender.#radio)) {
      return;
    }
    const neighbors = [...sender.#neighbors.keys()]
      .map((id) => `{"id":"${id}","rssi":-55.0,"snr":8.50}`)
      .join(",");
    this.#neighbors.set(sender.identifier, {
      model: sender.model,
      active: sender.#activeVersion,
      available: sender.#availableVersion,
      transmitted,
      hostTime: this.#clock.now(),
    });
    this.#emitEvent(
      "hello",
      `"src":"${sender.identifier}","epoch":1,"seq":${sender.#sequence},"model":"${sender.model}","version":${sender.#activeVersion},"available":${sender.#availableVersion},${sender.#vmFields()},"tx":${transmitted},"rssi":-55.0,"snr":8.50,"ferr":-1200,"neighbors":[${neighbors}]`,
    );
    this.#emitLine(`hello ${sender.identifier} -55 dBm`);
    if (
      sender.#activeVersion === this.#availableVersion &&
      this.#availableVersion > this.#activeVersion
    ) {
      this.#activate("hello", sender.identifier);
    }
    if (sender.#availableVersion < this.#availableVersion && this.#availableImage !== null) {
      this.#sendBurst("hello", sender.identifier, null, this.#fragmentSize);
    }
  }

  /**
   * Sends the available image in a burst to FFFF: every fragment, or those of `indices`, of
   * `fragmentSize` bytes. A burst held by a HELLO suspension is dropped: the next HELLO of the
   * peer asks for it again.
   */
  #sendBurst(
    cause: BurstCause,
    trigger: NodeIdentifier | null,
    indices: readonly number[] | null,
    fragmentSize: number,
  ): void {
    const image = this.#availableImage;
    if (image === null || this.presenceHoldSeconds !== null) {
      return;
    }
    const version = this.#availableVersion;
    const count = Math.ceil(image.length / fragmentSize);
    const selected = (indices ?? Array.from({ length: count }, (_, index) => index)).filter(
      (index) => index < count,
    );
    this.#emitEvent(
      "burst_start",
      `"version":${version},"size":${fragmentSize},"count":${selected.length},"cause":"${cause}","trigger":${trigger === null ? "null" : `"${trigger}"`}`,
    );
    const startHostTime = this.#clock.now();
    selected.forEach((index, position) => {
      const data = image.slice(index * fragmentSize, (index + 1) * fragmentSize);
      this.#transmitFrame(
        "fragment",
        "FFFF",
        FRAGMENT_HEADER_SIZE + data.length,
        `,"version":${version},"index":${index}`,
      );
      const peer = this.peer;
      if (peer !== null) {
        peer.#receiveFragment(this, {
          version,
          index,
          count,
          size: fragmentSize,
          remaining: selected.length - 1 - position,
          data,
        });
      }
    });
    this.#emitEvent(
      "burst_done",
      `"version":${version},"size":${fragmentSize},"sent":${selected.length},"duration":${Math.round((this.#clock.now() - startHostTime) * 1000)}`,
    );
    this.#emitLine(`burst ${version} ${selected.length}/${selected.length}`);
    const peer = this.peer;
    if (peer !== null) {
      peer.#concludeBurst(this);
    }
  }

  #receiveFragment(
    sender: SimulatedNode,
    fragment: {
      readonly version: number;
      readonly index: number;
      readonly count: number;
      readonly size: number;
      readonly remaining: number;
      readonly data: Uint8Array;
    },
  ): void {
    if (!this.#hearsChannel(sender.#radio)) {
      return;
    }
    const key = `${fragment.version}:${fragment.index}`;
    const delivery = (this.#fragmentDeliveries.get(key) ?? 0) + 1;
    this.#fragmentDeliveries.set(key, delivery);
    if (this.behavior.losesFragment?.(fragment.version, fragment.index, delivery) === true) {
      return;
    }
    let reception = this.#imageReception;
    const accepted =
      fragment.version > this.#availableVersion &&
      (reception === null || fragment.version >= reception.version);
    let brought = false;
    if (accepted) {
      if (reception === null || reception.version !== fragment.version) {
        reception = {
          version: fragment.version,
          bytes: new Uint8Array(IMAGE_BUFFER_SIZE),
          held: Array.from({ length: IMAGE_BUFFER_SIZE }, () => false),
          length: null,
          fragmentSize: fragment.size,
          fragmentCount: fragment.count,
          source: sender.identifier,
          fragments: 0,
          reports: 0,
          startNodeTime: this.#nodeTime(),
        };
        this.#imageReception = reception;
      }
      const offset = fragment.index * fragment.size;
      fragment.data.forEach((byte, position) => {
        if (!reception!.held[offset + position]) {
          brought = true;
          reception!.held[offset + position] = true;
          reception!.bytes[offset + position] = byte;
        }
      });
      if (fragment.index === fragment.count - 1) {
        reception.length = offset + fragment.data.length;
      }
      reception.fragmentSize = fragment.size;
      reception.fragmentCount = fragment.count;
      reception.source = sender.identifier;
      reception.fragments += 1;
    }
    this.#emitEvent(
      "fragment_rx",
      `"src":"${sender.identifier}","version":${fragment.version},"index":${fragment.index},"count":${fragment.count},"size":${fragment.size},"remaining":${fragment.remaining},"accepted":${accepted},"new":${brought},"rssi":-55.0,"snr":8.50`,
    );
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

  /** At the end of a burst of `sender`: completes the image or reports what is missing. */
  #concludeBurst(sender: SimulatedNode): void {
    const reception = this.#imageReception;
    if (reception === null) {
      return;
    }
    const missing = this.#missingFragments(reception);
    if (missing.length === 0 && reception.length !== null) {
      this.#completeReception(reception);
      return;
    }
    if (reception.reports >= MAXIMUM_SIMULATED_REPORTS || this.presenceHoldSeconds !== null) {
      return;
    }
    reception.reports += 1;
    this.#emitEvent(
      "report_sent",
      `"dst":"${reception.source}","version":${reception.version},"size":${reception.fragmentSize},"count":${reception.fragmentCount},"missing":[${missing.join(",")}],"round":${reception.reports}`,
    );
    this.#transmitFrame(
      "report",
      reception.source,
      REPORT_HEADER_SIZE + Math.ceil(reception.fragmentCount / 8),
      `,"version":${reception.version}`,
    );
    this.#emitLine(`report ${reception.version} ${missing.length} missing`);
    if (sender.identifier === reception.source) {
      sender.#receiveReport(this, reception, missing);
    }
  }

  #receiveReport(
    receiver: SimulatedNode,
    reception: ImageReception,
    missing: readonly number[],
  ): void {
    this.#emitEvent(
      "report_received",
      `"src":"${receiver.identifier}","version":${reception.version},"size":${reception.fragmentSize},"count":${reception.fragmentCount},"missing":[${missing.join(",")}]`,
    );
    if (reception.version === this.#availableVersion) {
      this.#sendBurst("report", receiver.identifier, missing, reception.fragmentSize);
    }
  }

  #completeReception(reception: ImageReception): void {
    const length = reception.length ?? 0;
    const bytes = reception.bytes.slice(0, length);
    this.#imageReception = null;
    const decoding = decodeImage(bytes);
    if (!decoding.valid) {
      this.#emitEvent(
        "image_rejected",
        `"version":${reception.version},"reason":"${decoding.reason}","src":"${reception.source}"`,
      );
      return;
    }
    this.#acceptImage(bytes);
    this.#emitEvent(
      "image",
      `"version":${reception.version},"size":${decoding.image.programLength},"image_size":${length},"via":"radio","src":"${reception.source}","fragments":${reception.fragments},"reports":${reception.reports},"duration":${Math.round(this.#nodeTime() - reception.startNodeTime)}`,
    );
    this.#emitLine(`image ${reception.version} radio`);
    const announcer = [...this.#neighbors.entries()].find(
      ([, neighbor]) => neighbor.active === reception.version,
    );
    if (announcer !== undefined && reception.version > this.#activeVersion) {
      // #activate() sends the HELLO of the version change.
      this.#activate("neighbor", announcer[0]);
    } else {
      this.sendHello();
    }
    this.#sendBurst("complete", null, null, this.#fragmentSize);
  }

  #executeRadio(argumentsList: readonly string[]): void {
    if (argumentsList.length === 0) {
      this.#emitRadio();
      return;
    }
    if (this.behavior.ignoresRadio === true) {
      return;
    }
    if (this.#radioRefusalsLeft > 0) {
      this.#radioRefusalsLeft -= 1;
      this.#emitError("radio", this.behavior.radioRefusal?.reason ?? "busy");
      return;
    }
    for (let index = 0; index + 1 < argumentsList.length; index += 2) {
      const key = argumentsList[index] as keyof RadioState;
      this.#radio[key] = Number(argumentsList[index + 1]);
    }
    this.#emitRadio();
    this.#emitLine(`radio ${this.#radio.sf}/${this.#radio.bw} +${this.#radio.power} dBm`);
  }

  #executePresence(argumentsList: readonly string[]): void {
    if (this.behavior.presenceRefusal !== undefined) {
      this.#emitError("presence", this.behavior.presenceRefusal);
      return;
    }
    if (argumentsList[0] === "off") {
      this.presenceHoldSeconds = Number(argumentsList[1]);
      this.#emitEvent("presence", `"state":"off","remaining":${this.presenceHoldSeconds}`);
    } else {
      this.presenceHoldSeconds = null;
      this.#emitEvent("presence", `"state":"on","remaining":null`);
    }
  }

  #executeEcho(argumentsList: readonly string[]): void {
    const destination = argumentsList[0] ?? "";
    const size = Number(argumentsList[1] ?? "16");
    const number = ++this.#echoCounter;
    const timeOnAir = timeOnAirFor(computeFrameLength(size), this.#radio);
    const peer = this.peer;
    const heard =
      peer !== null &&
      peer.identifier === destination &&
      peer.#hearsChannel(this.#radio) &&
      peer.behavior.losesEchoRequest?.(number) !== true;
    if (!heard) {
      const timeout = 2 * Math.ceil(timeOnAir / 1000) + 1000;
      this.#clock.advanceBy(timeout);
      this.#emitEvent(
        "echo_lost",
        `"dst":"${destination}","n":${number},"size":${size},"timeout":${timeout}`,
      );
      return;
    }
    this.#clock.advanceBy(timeOnAir / 1000);
    const forwardRssi = -60 - (number % 3);
    const forwardSnr = 7.5 + (number % 2) * 0.25;
    peer.#emitEvent(
      "echo_served",
      `"src":"${this.identifier}","n":${number},"size":${size},"rssi":${forwardRssi},"snr":${forwardSnr}`,
    );
    this.#clock.advanceBy(timeOnAir / 1000);
    const roundTrip = 2 * timeOnAir + 3000;
    this.#emitEvent(
      "echo",
      `"dst":"${destination}","n":${number},"size":${size},"rtt":${roundTrip},"rssi":-62,"snr":6.5,"remote_rssi":${forwardRssi},"remote_snr":${forwardSnr}`,
    );
  }

  #hearsChannel(senderRadio: RadioState): boolean {
    return (
      Math.abs(senderRadio.freq - this.#radio.freq) < 0.0005 &&
      senderRadio.sf === this.#radio.sf &&
      senderRadio.bw === this.#radio.bw &&
      senderRadio.cr === this.#radio.cr
    );
  }

  #executeRun(argumentsList: readonly string[]): void {
    if (argumentsList[0] === "stop") {
      this.#stopRequested = true;
      const held = this.#heldRun;
      if (held !== null) {
        this.#heldRun = null;
        this.#emitEvent(
          "run_done",
          `"run":${held.run},"count":${held.count},"sent":0,"duration":0,"aborted":true`,
        );
      }
      return;
    }
    const [count, size] = argumentsList.map(Number);
    this.#runCounter += 1;
    const run: PendingRun = { run: this.#runCounter, count: count!, size: size! };
    this.#stopRequested = false;
    this.#emitEvent(
      "run_start",
      `"run":${run.run},"count":${run.count},"size":${run.size},"interval":0`,
    );
    this.#emitLine(`run ${run.run} start ${run.count}x${run.size}`);
    if (this.behavior.holdsRun === true) {
      this.#heldRun = run;
      return;
    }
    this.#transmitRun(run);
  }

  #transmitRun(run: PendingRun): void {
    const frameLength = computeFrameLength(run.size);
    const timeOnAir = timeOnAirFor(frameLength, this.#radio);
    const startHostTime = this.#clock.now();
    let sent = 0;
    for (let index = 0; index < run.count && !this.#stopRequested; index += 1) {
      this.#clock.advanceBy(timeOnAir / 1000);
      this.#sequence += 1;
      sent += 1;
      this.#emitEvent(
        "tx",
        `"type":"test","dst":"FFFF","seq":${this.#sequence},"size":${frameLength},"toa":${timeOnAir + 45},"toa_calc":${timeOnAir},"run":${run.run},"index":${index}`,
      );
      const peer = this.peer;
      if (peer !== null) {
        peer.#receiveTestPacket(this.identifier, run, index, this.#radio);
      }
      if (index + 1 < run.count) {
        this.#clock.advanceBy(PACKET_GAP_MILLISECONDS);
      }
    }
    const duration = Math.round((this.#clock.now() - startHostTime) * 1000);
    this.#emitEvent(
      "run_done",
      `"run":${run.run},"count":${run.count},"sent":${sent},"duration":${duration},"aborted":${this.#stopRequested}`,
    );
    this.#emitLine(`run ${run.run} done ${sent}/${run.count}`);
    const peer = this.peer;
    if (peer !== null) {
      peer.#closeReception(this.identifier, run);
    }
  }

  #receiveTestPacket(
    source: NodeIdentifier,
    run: PendingRun,
    index: number,
    senderRadio: RadioState,
  ): void {
    if (!this.#hearsChannel(senderRadio) || this.behavior.losesPacket?.(run.run, index) === true) {
      return;
    }
    const rssi = -40 - (index % 3) * 0.5;
    const snr = 9.5 + (index % 2) * 0.25;
    const key = `${source}:${run.run}`;
    const now = this.#nodeTime();
    const tally = this.#receptions.get(key) ?? {
      received: 0,
      rssiSum: 0,
      snrSum: 0,
      rssiMinimum: rssi,
      rssiMaximum: rssi,
      first: now,
      last: now,
    };
    tally.received += 1;
    tally.rssiSum += rssi;
    tally.snrSum += snr;
    tally.rssiMinimum = Math.min(tally.rssiMinimum, rssi);
    tally.rssiMaximum = Math.max(tally.rssiMaximum, rssi);
    tally.last = now;
    this.#receptions.set(key, tally);
    this.#emitEvent(
      "test_rx",
      `"src":"${source}","run":${run.run},"index":${index},"count":${run.count},"size":${run.size},"rssi":${rssi.toFixed(1)},"snr":${snr.toFixed(2)},"ferr":-1200`,
    );
  }

  #closeReception(source: NodeIdentifier, run: PendingRun): void {
    const key = `${source}:${run.run}`;
    const tally = this.#receptions.get(key);
    this.#receptions.delete(key);
    if (tally === undefined || this.behavior.omitsRunEnd === true) {
      // The firmware opens a reception with its first packet: no packet, no run_end.
      return;
    }
    const lastHeard = this.behavior.losesPacket?.(run.run, run.count - 1) !== true;
    this.#emitEvent(
      "run_end",
      `"src":"${source}","run":${run.run},"count":${run.count},"received":${tally.received},"pdr":${(tally.received / run.count).toFixed(4)},"rssi_avg":${(tally.rssiSum / tally.received).toFixed(1)},"rssi_min":${tally.rssiMinimum.toFixed(1)},"rssi_max":${tally.rssiMaximum.toFixed(1)},"snr_avg":${(tally.snrSum / tally.received).toFixed(2)},"first":${tally.first},"last":${tally.last},"reason":"${lastHeard ? "complete" : "timeout"}"`,
    );
  }
}

/** A sender and a receiver that hear each other. */
export function createSimulatedPair(
  clock: ManualTimeSource,
  senderBehavior: SimulatedNodeBehavior = {},
  receiverBehavior: SimulatedNodeBehavior = {},
): { sender: SimulatedNode; receiver: SimulatedNode } {
  const sender = new SimulatedNode("5C21", "V2", clock, senderBehavior);
  const receiver = new SimulatedNode("3A7F", "V4.3", clock, receiverBehavior);
  sender.peer = receiver;
  receiver.peer = sender;
  return { sender, receiver };
}

/**
 * A node simulated for the tests: it answers console commands with the lines the firmware would
 * write (docs/protocol/console.md) and delivers them through the console parser. Two simulated
 * nodes linked as peers exchange TEST packets instantly; the manual clock advances with the time
 * on air of each packet.
 */
import type { CampaignNode } from "$lib/measurements/capacity-test-campaign.ts";
import type { BoardModel, ConsoleEvent, NodeIdentifier } from "$lib/console/console-event.ts";
import { parseConsoleLine } from "$lib/console/console-line-parser.ts";
import { DEFAULT_RADIO_SETTINGS, timeOnAirFor } from "$lib/radio/radio-settings.ts";
import { computeFrameLength } from "$lib/radio/time-on-air.ts";
import type { ManualTimeSource } from "$lib/utils/time-source.ts";

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
}

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
  #stopRequested = false;
  readonly #receptions = new Map<string, ReceptionTally>();

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
      case "status":
        this.#emitEvent(
          "status",
          `"id":"${this.identifier}","model":"${this.model}","epoch":1,"tx":${this.#sequence},"rx":0,"dropped":0,"heap":200000`,
        );
        this.#emitRadio();
        break;
      default:
        this.#emitError(words[0] ?? "", "unknown_command");
    }
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
    const sameChannel =
      Math.abs(senderRadio.freq - this.#radio.freq) < 0.0005 &&
      senderRadio.sf === this.#radio.sf &&
      senderRadio.bw === this.#radio.bw &&
      senderRadio.cr === this.#radio.cr;
    if (!sameChannel || this.behavior.losesPacket?.(run.run, index) === true) {
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

/**
 * Reactive state of the control panel. It connects the node directory, the event stream, the
 * test-run ledger, the event journal, the radio test sessions, the update workflow and the
 * exports, and publishes immutable snapshots of them for the views, at most once every
 * REFRESH_INTERVAL_MILLISECONDS. The domain modules stay free of Svelte.
 */
import { MeasurementSheet } from "$lib/state/measurement-sheet.svelte.ts";
import {
  CapacityTestCampaign,
  isCampaignActive,
  type CampaignSnapshot,
} from "$lib/measurements/capacity-test-campaign.ts";
import {
  buildCapacityTestPlan,
  type CapacityTestConfiguration,
} from "$lib/measurements/capacity-test-plan.ts";
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import {
  CommunicationTest,
  isCommunicationTestActive,
  type CommunicationTestConfiguration,
  type CommunicationTestSnapshot,
} from "$lib/measurements/communication-test.ts";
import {
  RECEIVER_EXPORT_LAYOUT,
  SENDER_EXPORT_LAYOUT,
  buildReceiverExport,
  buildSenderExport,
} from "$lib/measurements/communication-test-export.ts";
import {
  CommunicationReceiver,
  isReceiverModeActive,
  type ReceiverModeSnapshot,
} from "$lib/measurements/communication-receiver.ts";
import type { Modulation, RadioSettings } from "$lib/radio/radio-settings.ts";
import {
  EchoSeries,
  isEchoSeriesActive,
  type EchoSeriesSnapshot,
} from "$lib/measurements/echo-series.ts";
import { EventJournal } from "$lib/measurements/event-journal.ts";
import { UPDATE_EXPORT_LAYOUT } from "$lib/update/update-export.ts";
import { UpdateController } from "$lib/update/update-controller.svelte.ts";
import { buildConnectionGraph, type ConnectionGraph } from "$lib/node-session/connection-graph.ts";
import type { NodePort } from "$lib/nodes/node-port.ts";
import {
  buildExportFolder,
  formatLocalDate,
  type ExportFolder,
  type ExportLayout,
  type ExportedEvent,
  type MeasurementDescription,
  type MeasurementExport,
  type MeasurementTest,
  type ParticipatingNode,
} from "$lib/measurements/measurement-export.ts";
import { RUN_EXPORT_LAYOUTS, buildRunExport } from "$lib/measurements/run-export.ts";
import { NodeConnection, type ConsoleRecord } from "$lib/node-session/node-connection.ts";
import {
  TestRunLedger,
  type TestRunSummaryRow,
  type TestRunView,
} from "$lib/measurements/test-run-ledger.ts";
import {
  downloadMeasurementFiles,
  isDirectoryPickerAvailable,
  isPickerCancellation,
  writeMeasurementToDirectory,
  type ExportOutcome,
  type ExportResult,
} from "$lib/measurements/measurement-writer.ts";
import { TRANSPORT_LABELS, type ConsoleTransport } from "$lib/transports/console-transport.ts";
import { describeError } from "$lib/utils/error-description.ts";
import { SYSTEM_TIME_SOURCE, scheduleRepeatedly, type TimeSource } from "$lib/utils/time-source.ts";
import {
  isWebSerialAvailable,
  requestSerialConsoleTransport,
} from "$lib/transports/serial-console-transport.ts";
import { WebSocketConsoleTransport } from "$lib/transports/websocket-console-transport.ts";
import { EventStream } from "$lib/state/event-stream.svelte.ts";
import { NodeDirectory } from "$lib/state/node-directory.svelte.ts";
import {
  findRefusal,
  listRadioTestActivities,
  type RadioAction,
  type RadioTestActivity,
  type RadioTestKind,
  type RadioTestRefusal,
  type SessionTestKind,
  type SingleNodeRadioTestKind,
  type TestTarget,
} from "$lib/state/radio-test-activity.ts";
import type { NoticeLevel, PanelNotice, SessionNotice } from "$lib/state/panel-notice.ts";
import type { PanelSection } from "$lib/state/panel-sections.ts";
import { RadioTestSession } from "$lib/state/radio-test-session.svelte.ts";

/** Shortest time between two refreshes of the views. */
export const REFRESH_INTERVAL_MILLISECONDS = 100;
const TICK_INTERVAL_MILLISECONDS = 1000;
const INFORMATION_NOTICE_LIFETIME_MILLISECONDS = 10_000;

/** The exports of the panel, each with its export button. */
export type PanelExportKind =
  | MeasurementTest
  | "communication-sender"
  | "communication-receiver"
  | "update";

/** One export of the panel: its files, known before exporting, and the action that writes them. */
export interface PanelExport {
  readonly layout: ExportLayout;
  /**
   * Writes the export with the measurement sheet `description` and records how it went. Null when
   * there is nothing to export or the operator cancelled the folder chooser.
   */
  write(description: MeasurementDescription): Promise<ExportResult | null>;
}

/** Puts the files of an export on disk; null when the operator cancelled the folder chooser. */
export type ExportWriter = (
  folder: ExportFolder,
  localDate: string,
) => Promise<ExportOutcome | null>;

export interface ControlPanelOptions {
  /** Host time and timers; the system clock by default. */
  readonly timeSource?: TimeSource;
  /** Where exports go; the folder chooser or the downloads of the browser by default. */
  readonly writeExport?: ExportWriter;
}

export class ControlPanel {
  readonly nodes: NodeDirectory = new NodeDirectory({
    onSelectionChange: () => this.#publishStream(),
  });
  readonly stream = new EventStream();
  /**
   * One session per radio test that the panel starts (RADIO_TESTS of radio-test-activity.ts): the
   * exclusion rule sees every one of them.
   */
  readonly #sessions = {
    "capacity-test": this.#session<CapacityTestCampaign, CampaignSnapshot, "capacity-test">(
      "capacity-test",
      isCampaignActive,
    ),
    "echo-series": this.#session<EchoSeries, EchoSeriesSnapshot, "echo-series">(
      "echo-series",
      isEchoSeriesActive,
    ),
    "communication-test": this.#session<
      CommunicationTest,
      CommunicationTestSnapshot,
      "communication-test"
    >("communication-test", isCommunicationTestActive),
    "receiver-mode": this.#session<CommunicationReceiver, ReceiverModeSnapshot, "receiver-mode">(
      "receiver-mode",
      isReceiverModeActive,
    ),
  } satisfies {
    readonly [Kind in SessionTestKind]: { readonly kind: Kind; readonly activity: unknown };
  };
  readonly campaign = this.#sessions["capacity-test"];
  readonly echoSeries = this.#sessions["echo-series"];
  readonly communicationTest = this.#sessions["communication-test"];
  readonly receiverMode = this.#sessions["receiver-mode"];

  runs = $state.raw<readonly TestRunView[]>([]);
  summaryRows = $state.raw<readonly TestRunSummaryRow[]>([]);
  journalSize = $state(0);
  journalRejectedCount = $state(0);
  journalStartTime = $state<number | null>(null);
  participatingNodes = $state.raw<readonly ParticipatingNode[]>([]);
  notices = $state.raw<readonly PanelNotice[]>([]);
  /** The connection graph of the open connections, at the host time of the last refresh. */
  connectionGraph = $state.raw<ConnectionGraph>(buildConnectionGraph([], 0));
  /** Host time, updated every second, for ages and remaining times. */
  now = $state(0);

  /** What the operator fills in once per field trip, for every export of the panel. */
  readonly measurementSheet = new MeasurementSheet();
  /** Nodes of the power sweep and capacity test exports: the participating ones not excluded. */
  readonly exportedNodes: readonly ParticipatingNode[] = $derived(
    this.participatingNodes.filter(
      (node) => !this.measurementSheet.excludedNodes.includes(node.id),
    ),
  );
  /**
   * How the last export of each kind went, until the record it came from is discarded: the
   * measurement record for most, the test itself for each side of the communication test.
   */
  exportResults = $state.raw<ReadonlyMap<PanelExportKind, ExportResult>>(new Map());
  /**
   * Signing, loading and activation of the update section, with the record of the update commands
   * and their metrics, computed while the update section is visible.
   */
  readonly update: UpdateController;
  readonly exports: { readonly [Kind in PanelExportKind]: PanelExport } = {
    "power-sweep": this.#runExport("power-sweep"),
    "capacity-test": this.#runExport("capacity-test"),
    "communication-sender": {
      layout: SENDER_EXPORT_LAYOUT,
      write: (description) => this.#exportCommunicationTest(description),
    },
    "communication-receiver": {
      layout: RECEIVER_EXPORT_LAYOUT,
      write: (description) => this.#exportReceiverMode(description),
    },
    update: {
      layout: UPDATE_EXPORT_LAYOUT,
      write: (description) =>
        this.#export("update", () => this.update.record.exportOf(description)),
    },
  };

  readonly webSerialAvailable = isWebSerialAvailable();
  readonly directoryPickerAvailable = isDirectoryPickerAvailable();

  readonly #timeSource: TimeSource;
  readonly #writeExport: ExportWriter;
  readonly #ledger = new TestRunLedger();
  readonly #journal = new EventJournal();
  /** Connections that reached the open status, whose loss deserves a notice. */
  readonly #openedKeys = new Set<string>();
  #visibleSection = $state<PanelSection>("network");
  #noticeCounter = 0;
  #refreshPending = false;

  /** The tests in progress: at most one, unless runs were started at the console by hand. */
  readonly activities: readonly RadioTestActivity[] = $derived(
    listRadioTestActivities(
      Object.values(this.#sessions).flatMap((session) =>
        session.activity === null ? [] : [session.activity],
      ),
      this.nodes.connections,
    ),
  );

  constructor(options: ControlPanelOptions = {}) {
    this.#timeSource = options.timeSource ?? SYSTEM_TIME_SOURCE;
    this.#writeExport = options.writeExport ?? writeWithBrowser;
    this.update = new UpdateController(this, {
      journal: this.#journal,
      timeSource: this.#timeSource,
      connection: (key) => this.nodes.connection(key),
      send: (key, line) => this.sendCommand(key, line),
    });
    this.now = this.#timeSource.now();
    scheduleRepeatedly(this.#timeSource, () => this.#tick(), TICK_INTERVAL_MILLISECONDS);
  }

  get visibleSection(): PanelSection {
    return this.#visibleSection;
  }

  set visibleSection(section: PanelSection) {
    this.#visibleSection = section;
    this.#refresh();
  }

  /** True while any radio test runs, so that closing the page asks first. */
  get hasActiveTest(): boolean {
    return this.activities.length > 0;
  }

  /** Why `action` cannot start now on the nodes of `keys`, or null when it can. */
  refusal(action: RadioAction, ...keys: string[]): RadioTestRefusal | null {
    return findRefusal(action, keys, this.activities, (key) => this.nodes.byKey(key));
  }

  /**
   * The node of a section that runs the tests of `kinds`: the node of the test while one runs,
   * else the node chosen above.
   */
  testTarget(...kinds: RadioTestKind[]): TestTarget {
    const activity = this.activities.find((candidate) => kinds.includes(candidate.kind));
    const key = activity?.keys[0];
    return key === undefined
      ? { pinned: false, connection: this.nodes.selectedIdentified }
      : { pinned: true, connection: this.nodes.identifiedByKey(key) };
  }

  async connectSerial(): Promise<void> {
    let transport;
    try {
      transport = await requestSerialConsoleTransport();
    } catch (error) {
      this.notify("error", `No se pudo elegir el puerto: ${describeError(error)}`);
      return;
    }
    if (transport !== null) {
      await this.connect(transport);
    }
  }

  async connectWifi(): Promise<void> {
    await this.connect(new WebSocketConsoleTransport());
  }

  /**
   * Opens a connection and chooses its node at once. If the connection does not open, the node
   * chosen before comes back, unless the operator chose another one meanwhile.
   */
  async connect(transport: ConsoleTransport): Promise<void> {
    const key = this.nodes.nextKey(transport.kind);
    const previousKey = this.nodes.selectedKey;
    this.nodes.select(key);
    if (!(await this.#openConnection(key, transport))) {
      this.nodes.restoreSelection(previousKey, key);
    }
  }

  async disconnect(key: string): Promise<void> {
    await this.nodes.connection(key)?.close();
    this.#scheduleRefresh();
  }

  /** Forgets a closed connection; its events stay in the journal until it is cleared. */
  remove(key: string): void {
    if (this.nodes.remove(key)) {
      this.#scheduleRefresh();
    }
  }

  /** Sends a command to a node; reports a failure as a notice and returns false. */
  async sendCommand(key: string, command: string): Promise<boolean> {
    const connection = this.nodes.connection(key);
    if (connection === undefined) {
      return false;
    }
    try {
      await connection.sendCommand(command);
      return true;
    } catch (error) {
      this.notify("error", `No se pudo enviar «${command}»: ${describeError(error)}`);
      return false;
    } finally {
      this.#scheduleRefresh();
    }
  }

  /**
   * Sends a line the operator typed. A `load_image` or an `activate` typed by hand counts for the
   * update metrics like those of the update section.
   */
  sendTypedCommand(key: string, line: string): Promise<boolean> {
    return this.update.record.sendTyped(key, line);
  }

  /** Sends a `run` command of the power sweep, unless the exclusion rule refuses it. */
  async startManualRun(key: string, command: string): Promise<boolean> {
    return this.#allows("manual-run", key) && (await this.sendCommand(key, command));
  }

  /** Sends a `radio` command that changes settings, unless the exclusion rule refuses it. */
  async changeRadioSettings(key: string, command: string): Promise<boolean> {
    return this.#allows("radio-settings", key) && (await this.sendCommand(key, command));
  }

  startCampaign(
    configuration: CapacityTestConfiguration,
    senderKey: string,
    receiverKey: string,
  ): void {
    if (!this.#allows("capacity-test", senderKey, receiverKey)) {
      return;
    }
    const sender = this.nodes.port(senderKey);
    const receiver = this.nodes.port(receiverKey);
    if (sender === null || receiver === null) {
      return;
    }
    const campaign = new CapacityTestCampaign({
      sender,
      receiver,
      points: buildCapacityTestPlan(configuration),
      timeSource: this.#timeSource,
      onChange: this.campaign.publish,
      onSilentReception: (senderIdentifier, run, receiverIdentifier) => {
        this.#ledger.closeReceptionWithoutPackets(senderIdentifier, run, receiverIdentifier);
        this.#scheduleRefresh();
      },
    });
    this.campaign.begin(
      campaign,
      campaign.snapshot,
      [senderKey, receiverKey],
      [sender.identifier, receiver.identifier],
    );
    this.campaign.follow(campaign.run(), {
      failure: "La prueba de capacidad falló",
      describe: (snapshot) => [
        {
          level: "information",
          text:
            snapshot.status === "finished"
              ? "La prueba de capacidad terminó."
              : "La prueba de capacidad se detuvo.",
        },
      ],
    });
  }

  pauseCampaign(): void {
    this.campaign.test?.pause();
  }

  resumeCampaign(): void {
    this.campaign.test?.resume();
  }

  stopCampaign(): void {
    this.campaign.test?.stop();
  }

  /** Forgets the results of a campaign that ended; the summary rows stay in the ledger. */
  discardCampaign(): void {
    this.campaign.discard();
  }

  /**
   * Starts the sender side of a communication test: the node of `key` asks `destination` for the
   * echoes. The operator of the destination must have activated receiver mode with the same
   * modulation.
   */
  startCommunicationTest(
    configuration: CommunicationTestConfiguration,
    key: string,
    destination: NodeIdentifier,
  ): void {
    const prepared = this.#prepare("communication-test", key);
    if (prepared === null) {
      return;
    }
    const test = new CommunicationTest({
      ...prepared,
      destination,
      configuration,
      timeSource: this.#timeSource,
      onChange: this.communicationTest.publish,
    });
    this.#forgetExport("communication-sender");
    this.communicationTest.begin(test, test.snapshot, [key], [prepared.node.identifier]);
    this.communicationTest.follow(test.run(), {
      failure: "La prueba de comunicación falló",
      describe: (snapshot) => [
        snapshot.status === "failed" && snapshot.failure !== null
          ? { level: "error", text: `La prueba de comunicación falló: ${snapshot.failure}` }
          : {
              level: "information",
              text:
                snapshot.status === "finished"
                  ? "La prueba de comunicación terminó."
                  : "La prueba de comunicación se detuvo.",
            },
        ...restorationNotices(snapshot),
      ],
    });
  }

  stopCommunicationTest(): void {
    this.communicationTest.test?.stop();
  }

  discardCommunicationTest(): void {
    this.communicationTest.discard();
    this.#forgetExport("communication-sender");
  }

  /**
   * Puts the node of `key` in receiver mode: HELLO held and the modulation agreed with the
   * operator of the sender. Echoes from any node are answered and recorded until deactivation.
   */
  activateReceiverMode(key: string, modulation: Modulation): void {
    const prepared = this.#prepare("receiver-mode", key);
    if (prepared === null) {
      return;
    }
    const receiver = new CommunicationReceiver({
      ...prepared,
      modulation,
      timeSource: this.#timeSource,
      onChange: this.receiverMode.publish,
    });
    this.#forgetExport("communication-receiver");
    this.receiverMode.begin(receiver, receiver.snapshot, [key], [prepared.node.identifier]);
    this.receiverMode.follow(receiver.activate(), {
      failure: "No se pudo activar el modo receptor",
      describe: (snapshot) =>
        snapshot.status === "failed"
          ? [
              {
                level: "error",
                text: `No se pudo activar el modo receptor: ${snapshot.failure ?? ""}`,
              },
              ...restorationNotices(snapshot),
            ]
          : [],
    });
  }

  deactivateReceiverMode(): void {
    const receiver = this.receiverMode.test;
    if (receiver !== null) {
      this.receiverMode.follow(receiver.deactivate(), {
        failure: "No se pudo desactivar el modo receptor",
        describe: restorationNotices,
      });
    }
  }

  discardReceiverMode(): void {
    this.receiverMode.discard();
    this.#forgetExport("communication-receiver");
  }

  /**
   * Requests `count` echoes from the node of `requesterKey` to `destination`, one at a time; a
   * single echo too, so that it waits for the tests that change the radio of the node.
   */
  startEchoSeries(
    requesterKey: string,
    destination: string,
    size: number | undefined,
    count: number,
  ): void {
    const prepared = this.#prepare("echo-series", requesterKey);
    if (prepared === null) {
      return;
    }
    const series = new EchoSeries({
      ...prepared,
      destination,
      size,
      count,
      timeSource: this.#timeSource,
      onChange: this.echoSeries.publish,
    });
    this.echoSeries.begin(series, series.snapshot, [requesterKey], [prepared.node.identifier]);
    this.echoSeries.follow(series.run(), {
      failure: "La serie de ecos falló",
      describe: (snapshot) =>
        snapshot.status === "failed" && snapshot.failure !== null
          ? [{ level: "error", text: snapshot.failure }]
          : [],
    });
  }

  stopEchoSeries(): void {
    this.echoSeries.test?.stop();
  }

  #exportCommunicationTest(description: MeasurementDescription): Promise<ExportResult | null> {
    return this.#export("communication-sender", () => {
      const snapshot = this.communicationTest.snapshot;
      if (snapshot === null || snapshot.startHostTime === null || this.communicationTest.isActive) {
        return null;
      }
      const node = snapshot.requester;
      return buildSenderExport(
        snapshot,
        description,
        this.#participatingNodesAmong([node, snapshot.responder]),
        this.#eventsOf(node, snapshot.startHostTime, snapshot.endHostTime),
      );
    });
  }

  #exportReceiverMode(description: MeasurementDescription): Promise<ExportResult | null> {
    return this.#export("communication-receiver", () => {
      const snapshot = this.receiverMode.snapshot;
      if (snapshot === null || this.receiverMode.isActive) {
        return null;
      }
      return buildReceiverExport(
        snapshot,
        description,
        this.#participatingNodesAmong([snapshot.node]),
        this.#eventsOf(snapshot.node, snapshot.activationHostTime, snapshot.deactivationHostTime),
      );
    });
  }

  #runExport(test: MeasurementTest): PanelExport {
    return {
      layout: RUN_EXPORT_LAYOUTS[test],
      write: (description) => this.#export(test, () => this.#buildRunExport(test, description)),
    };
  }

  #buildRunExport(test: MeasurementTest, description: MeasurementDescription): MeasurementExport {
    const selected = new Set(this.exportedNodes.map((node) => node.id));
    const participating = this.#journal.participatingNodes();
    const participatingIdentifiers = new Set(participating.map((node) => node.id));
    // A run belongs to the export when its receiver was chosen and its sender was either chosen
    // or never connected to the panel.
    const rows = this.#ledger.rows.filter(
      (row) =>
        selected.has(row.receiver) &&
        (selected.has(row.sender) || !participatingIdentifiers.has(row.sender)),
    );
    return buildRunExport(
      test,
      description,
      participating.filter((node) => selected.has(node.id)),
      this.#journal.events(selected),
      rows,
    );
  }

  /** Discards the recorded events and runs, to start a new measurement. */
  clearMeasurementRecord(): void {
    this.#journal.clear();
    this.#ledger.clear();
    this.update.record.clear();
    this.exportResults = new Map();
    this.#scheduleRefresh();
  }

  clearStream(): void {
    this.stream.clear();
    this.#scheduleRefresh();
  }

  notify(level: NoticeLevel, text: string): void {
    const identifier = ++this.#noticeCounter;
    this.notices = [...this.notices, { identifier, level, text }];
    if (level === "information") {
      this.#timeSource.schedule(
        () => this.dismissNotice(identifier),
        INFORMATION_NOTICE_LIFETIME_MILLISECONDS,
      );
    }
  }

  dismissNotice(identifier: number): void {
    this.notices = this.notices.filter((notice) => notice.identifier !== identifier);
  }

  /** Applies the exclusion rule to an action; tells the operator why it was refused. */
  #allows(action: RadioAction, ...keys: string[]): boolean {
    // The views may be up to one refresh old; the rule looks at the connections as they are now.
    this.nodes.publish();
    const refusal = this.refusal(action, ...keys);
    if (refusal !== null) {
      this.notify("error", refusal.message);
      return false;
    }
    return true;
  }

  #session<Test, Snapshot, const Kind extends SessionTestKind>(
    kind: Kind,
    isActive: (snapshot: Snapshot) => boolean,
  ): RadioTestSession<Test, Snapshot, Kind> {
    return new RadioTestSession<Test, Snapshot, Kind>({
      kind,
      isActive,
      notify: (level, text) => this.notify(level, text),
    });
  }

  /** The port and the radio settings a one-node test starts from, once the rule allows it. */
  #prepare(
    action: SingleNodeRadioTestKind,
    key: string,
  ): { node: NodePort; radio: RadioSettings } | null {
    if (!this.#allows(action, key)) {
      return null;
    }
    const node = this.nodes.port(key);
    const radio = this.nodes.byKey(key)?.state.radio ?? null;
    return node === null || radio === null ? null : { node, radio };
  }

  #participatingNodesAmong(identifiers: readonly NodeIdentifier[]): ParticipatingNode[] {
    const wanted = new Set(identifiers);
    return this.#journal.participatingNodes().filter((node) => wanted.has(node.id));
  }

  #eventsOf(node: NodeIdentifier, start: number, end: number | null): ExportedEvent[] {
    const last = end ?? this.#timeSource.now();
    return [...this.#journal.events(new Set([node]))].filter(
      (event) => event.hostTime >= start && event.hostTime <= last,
    );
  }

  /**
   * Writes the export that `build` describes and records how it went for `kind`. Null, and
   * nothing recorded, when there is nothing to export or the operator cancelled the chooser.
   */
  async #export(
    kind: PanelExportKind,
    build: () => MeasurementExport | null,
  ): Promise<ExportResult | null> {
    this.#forgetExport(kind);
    let result: ExportResult | null;
    try {
      const measurement = build();
      const exportDate = new Date(this.#timeSource.now());
      const outcome =
        measurement === null
          ? null
          : await this.#writeExport(
              buildExportFolder(measurement, exportDate, __PANEL_VERSION__),
              formatLocalDate(exportDate),
            );
      result = outcome === null ? null : { kind: "written", outcome };
    } catch (error) {
      result = { kind: "failed", message: describeError(error) };
    }
    if (result !== null) {
      this.exportResults = new Map([...this.exportResults, [kind, result]]);
    }
    return result;
  }

  #forgetExport(kind: PanelExportKind): void {
    if (this.exportResults.has(kind)) {
      const results = new Map(this.exportResults);
      results.delete(kind);
      this.exportResults = results;
    }
  }

  /** Returns false when the connection did not open. */
  async #openConnection(key: string, transport: ConsoleTransport): Promise<boolean> {
    const connection = new NodeConnection({ key, transport, timeSource: this.#timeSource });
    connection.subscribe((record) => this.#acceptRecord(connection, record));
    connection.subscribeToStatus(() => this.#acceptStatusChange(connection));
    this.nodes.add(connection);
    this.#scheduleRefresh();
    try {
      await connection.open();
      return true;
    } catch (error) {
      this.nodes.forget(key);
      this.notify(
        "error",
        `No se pudo conectar por ${TRANSPORT_LABELS[transport.kind]}: ${describeError(error)}`,
      );
      return false;
    } finally {
      this.#scheduleRefresh();
    }
  }

  #acceptRecord(connection: NodeConnection, record: ConsoleRecord): void {
    this.stream.append(record);
    if (record.kind === "event" || record.kind === "unrecognized") {
      this.#journal.append(
        connection.key,
        record.text,
        record.kind === "event" ? record.event : record.object,
        record.hostTime,
        record.kind === "event" ? record.event : null,
      );
    }
    if (record.kind === "event") {
      this.update.record.acceptEvent(connection.key, connection.state);
    }
    const identifier = connection.state.identifier;
    if (identifier !== null) {
      this.#journal.assignNode(connection.key, identifier, connection.state.model);
      if (record.kind === "event") {
        this.#ledger.acceptEvent(identifier, record.event, record.hostTime);
      }
    }
    this.#scheduleRefresh();
  }

  #acceptStatusChange(connection: NodeConnection): void {
    const identifier = connection.state.identifier;
    if (
      connection.status === "closed" &&
      identifier !== null &&
      !this.nodes.isReachedElsewhere(connection)
    ) {
      this.#ledger.markNodeAbsent(identifier);
    }
    if (connection.status === "open") {
      this.#openedKeys.add(connection.key);
    }
    if (
      connection.status === "closed" &&
      connection.closureMessage !== null &&
      this.#openedKeys.has(connection.key)
    ) {
      this.notify("error", connection.closureMessage);
    }
    this.#scheduleRefresh();
  }

  #tick(): void {
    this.now = this.#timeSource.now();
    if (this.#ledger.closeOverdueReceptions(this.now)) {
      this.#scheduleRefresh();
    }
    this.#publishGraph();
  }

  #scheduleRefresh(): void {
    if (this.#refreshPending) {
      return;
    }
    this.#refreshPending = true;
    this.#timeSource.schedule(() => {
      this.#refreshPending = false;
      this.#refresh();
    }, REFRESH_INTERVAL_MILLISECONDS);
  }

  #refresh(): void {
    this.nodes.publish();
    this.#publishGraph();
    this.#publishStream();
    if (this.runs !== this.#ledger.runs) {
      this.runs = this.#ledger.runs;
      this.summaryRows = this.#ledger.rows;
    }
    this.journalSize = this.#journal.size;
    this.journalRejectedCount = this.#journal.rejectedCount;
    this.journalStartTime = this.#journal.firstHostTime;
    const participating = this.#journal.participatingNodes();
    if (!haveSameNodes(participating, this.participatingNodes)) {
      this.participatingNodes = participating;
    }
    // The journal can hold many events: the metrics wait for the section and for new events.
    if (this.#visibleSection === "update") {
      this.update.record.publishMetrics();
    }
  }

  #publishGraph(): void {
    this.connectionGraph = buildConnectionGraph(
      this.nodes.open.map((connection) => connection.state),
      this.now,
    );
  }

  #publishStream(): void {
    this.stream.publish(this.nodes.selected?.key ?? null, this.#visibleSection === "events");
  }
}

/** The notice for a node the test could not leave as it found it. */
function restorationNotices(snapshot: {
  readonly restored: boolean | null;
  readonly restorationProblems: readonly string[];
}): SessionNotice[] {
  return snapshot.restored === false
    ? [
        {
          level: "error",
          text:
            `No se pudo dejar el nodo como estaba: ${snapshot.restorationProblems.join(" ")} ` +
            "Conviene revisar los parámetros de radio del nodo o reiniciarlo.",
        },
      ]
    : [];
}

function haveSameNodes(
  first: readonly ParticipatingNode[],
  second: readonly ParticipatingNode[],
): boolean {
  return (
    first.length === second.length &&
    first.every(
      (node, index) => node.id === second[index]?.id && node.model === second[index]?.model,
    )
  );
}

async function writeWithBrowser(
  folder: ExportFolder,
  localDate: string,
): Promise<ExportOutcome | null> {
  try {
    return isDirectoryPickerAvailable()
      ? await writeMeasurementToDirectory(folder, localDate)
      : downloadMeasurementFiles(folder, localDate);
  } catch (error) {
    if (isPickerCancellation(error)) {
      return null;
    }
    throw error;
  }
}

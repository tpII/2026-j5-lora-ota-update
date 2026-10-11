/**
 * Reactive state of the control panel. It owns the connections, the test-run ledger, the event
 * journal, the capacity-test campaign and both sides of the communication test, and publishes immutable snapshots of them for the views.
 * The domain modules stay free of Svelte; this class only connects them and throttles updates.
 */
import { BoundedLog } from "$lib/utils/bounded-log.ts";
import {
  CapacityTestCampaign,
  type CampaignNode,
  type CampaignSnapshot,
} from "$lib/measurements/capacity-test-campaign.ts";
import {
  buildCapacityTestPlan,
  type CapacityTestConfiguration,
} from "$lib/measurements/capacity-test-plan.ts";
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import {
  CommunicationTest,
  type CommunicationTestConfiguration,
  type CommunicationTestSnapshot,
} from "$lib/measurements/communication-test.ts";
import {
  COMMUNICATION_TEST,
  buildCommunicationTestFiles,
  buildReceiverFiles,
  type CommunicationTestDescription,
} from "$lib/measurements/communication-test-metrics.ts";
import {
  CommunicationReceiver,
  type ReceiverModeSnapshot,
} from "$lib/measurements/communication-receiver.ts";
import type { Modulation } from "$lib/measurements/command-confirmation.ts";
import { EchoSeries, type EchoSeriesSnapshot } from "$lib/measurements/echo-series.ts";
import { EventJournal } from "$lib/measurements/event-journal.ts";
import {
  buildMeasurementFiles,
  buildMetadata,
  formatLocalDate,
  type MeasurementDescription,
  type ExportedEvent,
  type MeasurementFile,
  type ParticipatingNode,
} from "$lib/measurements/measurement-export.ts";
import {
  NodeConnection,
  type ConnectionStatus,
  type ConsoleRecord,
} from "$lib/nodes/node-connection.ts";
import type { NodeState } from "$lib/nodes/node-state.ts";
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
} from "$lib/measurements/measurement-writer.ts";
import {
  describeTransportError,
  type ConsoleTransport,
  type TransportKind,
} from "$lib/transports/console-transport.ts";
import {
  isWebSerialAvailable,
  requestSerialConsoleTransport,
} from "$lib/transports/serial-console-transport.ts";
import {
  DEFAULT_CONSOLE_ADDRESS,
  WebSocketConsoleTransport,
} from "$lib/transports/websocket-console-transport.ts";

/** Lines kept for the event stream view, across every connection. */
const STREAM_CAPACITY = 3000;
/** Shortest time between two refreshes of the views. */
const REFRESH_INTERVAL_MILLISECONDS = 100;
const TICK_INTERVAL_MILLISECONDS = 1000;
const INFORMATION_NOTICE_LIFETIME_MILLISECONDS = 10_000;

export interface ConnectionView {
  readonly key: string;
  readonly transportKind: TransportKind;
  readonly transportDescription: string;
  readonly status: ConnectionStatus;
  readonly closureMessage: string | null;
  readonly state: NodeState;
  /** Another open connection reaches the same node, so its lines arrive twice. */
  readonly duplicated: boolean;
}

export type NoticeLevel = "error" | "information";

export interface PanelNotice {
  readonly identifier: number;
  readonly level: NoticeLevel;
  readonly text: string;
}

export class ControlPanel {
  connections = $state.raw<readonly ConnectionView[]>([]);
  streamRecords = $state.raw<readonly ConsoleRecord[]>([]);
  runs = $state.raw<readonly TestRunView[]>([]);
  summaryRows = $state.raw<readonly TestRunSummaryRow[]>([]);
  journalSize = $state(0);
  journalRejectedCount = $state(0);
  journalStartTime = $state<number | null>(null);
  participatingNodes = $state.raw<readonly ParticipatingNode[]>([]);
  campaign = $state.raw<CampaignSnapshot | null>(null);
  echoSeries = $state.raw<EchoSeriesSnapshot | null>(null);
  /** Connection whose node runs the echo series. */
  echoSeriesKey = $state<string | null>(null);
  communicationTest = $state.raw<CommunicationTestSnapshot | null>(null);
  receiverMode = $state.raw<ReceiverModeSnapshot | null>(null);
  notices = $state.raw<readonly PanelNotice[]>([]);
  /** Host time, updated every second, for ages and remaining times. */
  now = $state(Date.now());

  readonly webSerialAvailable = isWebSerialAvailable();
  readonly directoryPickerAvailable = isDirectoryPickerAvailable();

  readonly #connections = new Map<string, NodeConnection>();
  readonly #viewCache = new Map<string, { revision: number; view: ConnectionView }>();
  readonly #stream = new BoundedLog<ConsoleRecord>(STREAM_CAPACITY);
  readonly #ledger = new TestRunLedger();
  readonly #journal = new EventJournal();
  #campaign: CapacityTestCampaign | null = null;
  #echoSeries: EchoSeries | null = null;
  #communicationTest: CommunicationTest | null = null;
  #receiverMode: CommunicationReceiver | null = null;
  #connectionCounter = 0;
  /** Connections that reached the open status, whose loss deserves a notice. */
  readonly #openedKeys = new Set<string>();
  #noticeCounter = 0;
  #refreshPending = false;

  constructor() {
    setInterval(() => this.#tick(), TICK_INTERVAL_MILLISECONDS);
    window.addEventListener("beforeunload", (event) => {
      if (this.isCampaignActive || this.isCommunicationTestActive || this.isReceiverModeActive) {
        event.preventDefault();
      }
    });
  }

  get isCampaignActive(): boolean {
    const status = this.campaign?.status;
    return (
      status === "running" || status === "pausing" || status === "paused" || status === "stopping"
    );
  }

  get hasWebSocketConnection(): boolean {
    return this.connections.some(
      (connection) => connection.transportKind === "websocket" && connection.status !== "closed",
    );
  }

  /** Open connections whose node is already identified. */
  get identifiedConnections(): readonly ConnectionView[] {
    return this.connections.filter(
      (connection) => connection.status === "open" && connection.state.identifier !== null,
    );
  }

  async connectSerial(): Promise<void> {
    let transport;
    try {
      transport = await requestSerialConsoleTransport();
    } catch (error) {
      // Closing the port chooser without choosing is not an error.
      if (!(error instanceof DOMException && error.name === "NotFoundError")) {
        this.notify("error", `No se pudo elegir el puerto: ${describeTransportError(error)}`);
      }
      return;
    }
    await this.#openConnection(`usb-${++this.#connectionCounter}`, transport);
  }

  async connectWifi(address = DEFAULT_CONSOLE_ADDRESS): Promise<void> {
    const transport = new WebSocketConsoleTransport(address);
    await this.#openConnection(`wifi-${++this.#connectionCounter}`, transport);
  }

  async disconnect(key: string): Promise<void> {
    await this.#connections.get(key)?.close();
    this.#scheduleRefresh();
  }

  /** Forgets a closed connection; its events stay in the journal until it is cleared. */
  remove(key: string): void {
    const connection = this.#connections.get(key);
    if (connection === undefined || connection.status !== "closed") {
      return;
    }
    this.#connections.delete(key);
    this.#viewCache.delete(key);
    this.#scheduleRefresh();
  }

  /** Sends a command to a node; reports a failure as a notice and returns false. */
  async sendCommand(key: string, command: string): Promise<boolean> {
    const connection = this.#connections.get(key);
    if (connection === undefined) {
      return false;
    }
    try {
      await connection.sendCommand(command);
      return true;
    } catch (error) {
      this.notify("error", `No se pudo enviar «${command}»: ${describeTransportError(error)}`);
      return false;
    } finally {
      this.#scheduleRefresh();
    }
  }

  connection(key: string): ConnectionView | undefined {
    return this.connections.find((connection) => connection.key === key);
  }

  startCampaign(
    configuration: CapacityTestConfiguration,
    senderKey: string,
    receiverKey: string,
  ): void {
    if (this.isCampaignActive) {
      return;
    }
    if (this.isCommunicationTestActive || this.isReceiverModeActive) {
      this.notify(
        "error",
        "Hay una prueba de comunicación en curso o el modo receptor está activo.",
      );
      return;
    }
    const sender = this.#nodePort(senderKey);
    const receiver = this.#nodePort(receiverKey);
    if (sender === null || receiver === null || sender.identifier === receiver.identifier) {
      this.notify("error", "La prueba necesita dos nodos distintos, conectados e identificados.");
      return;
    }
    const campaign = new CapacityTestCampaign({
      sender,
      receiver,
      points: buildCapacityTestPlan(configuration),
      onChange: (snapshot) => {
        this.campaign = snapshot;
      },
      onSilentReception: (senderIdentifier, run, receiverIdentifier) => {
        this.#ledger.closeReceptionWithoutPackets(senderIdentifier, run, receiverIdentifier);
        this.#scheduleRefresh();
      },
    });
    this.#campaign = campaign;
    this.campaign = campaign.snapshot;
    campaign.run().then(
      (snapshot) => {
        this.notify(
          "information",
          snapshot.status === "finished"
            ? "La prueba de capacidad terminó."
            : "La prueba de capacidad se detuvo.",
        );
      },
      (error: unknown) => {
        this.notify("error", `La prueba de capacidad falló: ${describeTransportError(error)}`);
      },
    );
  }

  pauseCampaign(): void {
    this.#campaign?.pause();
  }

  resumeCampaign(): void {
    this.#campaign?.resume();
  }

  stopCampaign(): void {
    this.#campaign?.stop();
  }

  get isCommunicationTestActive(): boolean {
    const status = this.communicationTest?.status;
    return status === "preparing" || status === "measuring" || status === "restoring";
  }

  /** True from the activation of receiver mode until its deactivation ends. */
  get isReceiverModeActive(): boolean {
    const status = this.receiverMode?.status;
    return status === "activating" || status === "active" || status === "deactivating";
  }

  /** True while any test changes the radio settings or the HELLO messages of a node. */
  get isRadioTestActive(): boolean {
    return (
      this.isCampaignActive ||
      this.isEchoSeriesActive ||
      this.isCommunicationTestActive ||
      this.isReceiverModeActive
    );
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
    if (this.isRadioTestActive) {
      this.notify("error", "Hay otra prueba en curso o el modo receptor está activo.");
      return;
    }
    const node = this.#nodePort(key);
    const radio = this.#connections.get(key)?.state.radio ?? null;
    if (node === null || radio === null) {
      this.notify(
        "error",
        "El nodo tiene que estar conectado, identificado y con sus parámetros de radio conocidos.",
      );
      return;
    }
    const test = new CommunicationTest({
      node,
      radio,
      destination,
      configuration,
      onChange: (snapshot) => {
        this.communicationTest = snapshot;
      },
    });
    this.#communicationTest = test;
    this.communicationTest = test.snapshot;
    test.run().then(
      (snapshot) => {
        if (snapshot.status === "failed" && snapshot.failure !== null) {
          this.notify("error", `La prueba de comunicación falló: ${snapshot.failure}`);
        } else {
          this.notify(
            "information",
            snapshot.status === "finished"
              ? "La prueba de comunicación terminó."
              : "La prueba de comunicación se detuvo.",
          );
        }
        this.#reportRestoration(snapshot.restored, snapshot.restorationProblems);
      },
      (error: unknown) => {
        this.notify("error", `La prueba de comunicación falló: ${describeTransportError(error)}`);
      },
    );
  }

  stopCommunicationTest(): void {
    this.#communicationTest?.stop();
  }

  discardCommunicationTest(): void {
    if (!this.isCommunicationTestActive) {
      this.#communicationTest = null;
      this.communicationTest = null;
    }
  }

  /**
   * Puts the node of `key` in receiver mode: HELLO held and the modulation agreed with the
   * operator of the sender. Echoes from any node are answered and recorded until deactivation.
   */
  activateReceiverMode(key: string, modulation: Modulation): void {
    if (this.isRadioTestActive) {
      this.notify("error", "Hay otra prueba en curso o el modo receptor ya está activo.");
      return;
    }
    const node = this.#nodePort(key);
    const radio = this.#connections.get(key)?.state.radio ?? null;
    if (node === null || radio === null) {
      this.notify(
        "error",
        "El nodo tiene que estar conectado, identificado y con sus parámetros de radio conocidos.",
      );
      return;
    }
    const receiver = new CommunicationReceiver({
      node,
      radio,
      modulation,
      onChange: (snapshot) => {
        this.receiverMode = snapshot;
      },
    });
    this.#receiverMode = receiver;
    this.receiverMode = receiver.snapshot;
    receiver.activate().then(
      (snapshot) => {
        if (snapshot.status === "failed") {
          this.notify("error", `No se pudo activar el modo receptor: ${snapshot.failure ?? ""}`);
          this.#reportRestoration(snapshot.restored, snapshot.restorationProblems);
        }
      },
      (error: unknown) => {
        this.notify(
          "error",
          `No se pudo activar el modo receptor: ${describeTransportError(error)}`,
        );
      },
    );
  }

  deactivateReceiverMode(): void {
    this.#receiverMode?.deactivate().then(
      (snapshot) => {
        this.#reportRestoration(snapshot.restored, snapshot.restorationProblems);
      },
      (error: unknown) => {
        this.notify(
          "error",
          `No se pudo desactivar el modo receptor: ${describeTransportError(error)}`,
        );
      },
    );
  }

  discardReceiverMode(): void {
    if (!this.isReceiverModeActive) {
      this.#receiverMode = null;
      this.receiverMode = null;
    }
  }

  /**
   * Exports the last communication test of the sender: its metrics, its echoes and the events of
   * the node while it lasted. Returns null when the operator cancelled the folder chooser.
   */
  async exportCommunicationTest(
    description: CommunicationTestDescription,
  ): Promise<ExportOutcome | null> {
    const snapshot = this.communicationTest;
    if (snapshot === null || snapshot.startHostTime === null || this.isCommunicationTestActive) {
      return null;
    }
    const node = snapshot.requester;
    const exportDate = new Date();
    const files = buildCommunicationTestFiles(
      snapshot,
      description,
      this.#participatingNodesAmong([node, snapshot.responder]),
      this.#eventsOf(node, snapshot.startHostTime, snapshot.endHostTime),
      exportDate,
      __PANEL_VERSION__,
    );
    return this.#writeCommunicationTestFiles(files, exportDate);
  }

  /** Exports what the node answered in receiver mode; null when the chooser was cancelled. */
  async exportReceiverMode(
    description: CommunicationTestDescription,
  ): Promise<ExportOutcome | null> {
    const snapshot = this.receiverMode;
    if (snapshot === null || this.isReceiverModeActive) {
      return null;
    }
    const exportDate = new Date();
    const files = buildReceiverFiles(
      snapshot,
      description,
      this.#participatingNodesAmong([snapshot.node]),
      this.#eventsOf(snapshot.node, snapshot.activationHostTime, snapshot.deactivationHostTime),
      exportDate,
      __PANEL_VERSION__,
    );
    return this.#writeCommunicationTestFiles(files, exportDate);
  }

  #participatingNodesAmong(identifiers: readonly NodeIdentifier[]): ParticipatingNode[] {
    const wanted = new Set(identifiers);
    return this.#journal.participatingNodes().filter((node) => wanted.has(node.id));
  }

  #eventsOf(node: NodeIdentifier, start: number, end: number | null): ExportedEvent[] {
    const last = end ?? Date.now();
    return [...this.#journal.events(new Set([node]))].filter(
      (event) => event.hostTime >= start && event.hostTime <= last,
    );
  }

  async #writeCommunicationTestFiles(
    files: readonly MeasurementFile[],
    exportDate: Date,
  ): Promise<ExportOutcome | null> {
    const localDate = formatLocalDate(exportDate);
    try {
      if (this.directoryPickerAvailable) {
        return await writeMeasurementToDirectory(files, localDate, COMMUNICATION_TEST);
      }
      return downloadMeasurementFiles(files, localDate, COMMUNICATION_TEST);
    } catch (error) {
      if (isPickerCancellation(error)) {
        return null;
      }
      throw error;
    }
  }

  #reportRestoration(restored: boolean | null, problems: readonly string[]): void {
    if (restored === false) {
      this.notify(
        "error",
        `No se pudo dejar el nodo como estaba: ${problems.join(" ")} ` +
          "Conviene revisar la radio desde la sección Radio o reiniciar el nodo.",
      );
    }
  }

  /** Forgets the results of a campaign that ended; the summary rows stay in the ledger. */
  discardCampaign(): void {
    if (!this.isCampaignActive) {
      this.#campaign = null;
      this.campaign = null;
    }
  }

  get isEchoSeriesActive(): boolean {
    const status = this.echoSeries?.status;
    return status === "running" || status === "stopping";
  }

  /** Requests `count` echoes from the node of `requesterKey` to `destination`, one at a time. */
  startEchoSeries(
    requesterKey: string,
    destination: string,
    size: number | undefined,
    count: number,
  ): void {
    if (this.isEchoSeriesActive) {
      return;
    }
    if (this.isCommunicationTestActive || this.isReceiverModeActive) {
      this.notify(
        "error",
        "Hay una prueba de comunicación en curso o el modo receptor está activo.",
      );
      return;
    }
    const node = this.#nodePort(requesterKey);
    if (node === null) {
      this.notify("error", "El nodo que pide los ecos tiene que estar conectado e identificado.");
      return;
    }
    const series = new EchoSeries({
      node,
      destination,
      size,
      count,
      onChange: (snapshot) => {
        this.echoSeries = snapshot;
      },
    });
    this.#echoSeries = series;
    this.echoSeriesKey = requesterKey;
    this.echoSeries = series.snapshot;
    series.run().then(
      (snapshot) => {
        if (snapshot.status === "failed" && snapshot.failure !== null) {
          this.notify("error", snapshot.failure);
        }
      },
      (error: unknown) => {
        this.notify("error", `La serie de ecos falló: ${describeTransportError(error)}`);
      },
    );
  }

  stopEchoSeries(): void {
    this.#echoSeries?.stop();
  }

  /** The summary row of a run, for the views of the campaign. */
  findSummaryRow(
    sender: NodeIdentifier,
    run: number,
    receiver: NodeIdentifier,
  ): TestRunSummaryRow | null {
    return this.#ledger.findRow(sender, run, receiver);
  }

  /**
   * Exports the events and the summary of the nodes chosen. Returns null when the operator
   * cancelled the folder chooser.
   */
  async exportMeasurement(
    description: MeasurementDescription,
    nodeIdentifiers: readonly NodeIdentifier[],
  ): Promise<ExportOutcome | null> {
    const selected = new Set(nodeIdentifiers);
    const participating = this.#journal.participatingNodes();
    const participatingIdentifiers = new Set(participating.map((node) => node.id));
    const nodes = participating.filter((node) => selected.has(node.id));
    // A run belongs to the export when its receiver was chosen and its sender was either chosen
    // or never connected to the panel.
    const rows = this.#ledger.rows.filter(
      (row) =>
        selected.has(row.receiver) &&
        (selected.has(row.sender) || !participatingIdentifiers.has(row.sender)),
    );
    const exportDate = new Date();
    const metadata = buildMetadata(description, nodes, exportDate, __PANEL_VERSION__);
    const files = buildMeasurementFiles(metadata, this.#journal.events(selected), rows);
    const localDate = formatLocalDate(exportDate);
    try {
      if (this.directoryPickerAvailable) {
        return await writeMeasurementToDirectory(files, localDate, description.test);
      }
      return downloadMeasurementFiles(files, localDate, description.test);
    } catch (error) {
      if (isPickerCancellation(error)) {
        return null;
      }
      throw error;
    }
  }

  /** Discards the recorded events and runs, to start a new measurement. */
  clearMeasurementRecord(): void {
    this.#journal.clear();
    this.#ledger.clear();
    this.#scheduleRefresh();
  }

  clearStream(): void {
    this.#stream.clear();
    this.#scheduleRefresh();
  }

  notify(level: NoticeLevel, text: string): void {
    const identifier = ++this.#noticeCounter;
    this.notices = [...this.notices, { identifier, level, text }];
    if (level === "information") {
      setTimeout(() => this.dismissNotice(identifier), INFORMATION_NOTICE_LIFETIME_MILLISECONDS);
    }
  }

  dismissNotice(identifier: number): void {
    this.notices = this.notices.filter((notice) => notice.identifier !== identifier);
  }

  async #openConnection(key: string, transport: ConsoleTransport): Promise<void> {
    const connection = new NodeConnection({ key, transport });
    connection.subscribe((record) => this.#acceptRecord(connection, record));
    connection.subscribeToStatus(() => this.#acceptStatusChange(connection));
    this.#connections.set(key, connection);
    this.#scheduleRefresh();
    try {
      await connection.open();
    } catch (error) {
      this.#connections.delete(key);
      this.#viewCache.delete(key);
      this.notify(
        "error",
        `No se pudo conectar por ${transport.kind === "serial" ? "USB" : "WiFi"}: ${describeTransportError(error)}`,
      );
    } finally {
      this.#scheduleRefresh();
    }
  }

  #acceptRecord(connection: NodeConnection, record: ConsoleRecord): void {
    this.#stream.append(record);
    if (record.kind === "event" || record.kind === "unrecognized") {
      this.#journal.append(
        connection.key,
        record.text,
        record.kind === "event" ? record.event : record.object,
        record.hostTime,
      );
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
    if (connection.status === "closed" && identifier !== null) {
      const stillConnected = [...this.#connections.values()].some(
        (other) =>
          other !== connection && other.status === "open" && other.state.identifier === identifier,
      );
      if (!stillConnected) {
        this.#ledger.markNodeAbsent(identifier);
      }
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

  /** The connection as the campaign and the echo series see a node. */
  #nodePort(key: string): CampaignNode | null {
    const connection = this.#connections.get(key);
    const identifier = connection?.state.identifier ?? null;
    if (connection === undefined || identifier === null || connection.status !== "open") {
      return null;
    }
    return {
      identifier,
      sendCommand: (command) => connection.sendCommand(command),
      subscribe: (listener) =>
        connection.subscribe((record) => {
          if (record.kind === "event") {
            listener(record.event, record.hostTime);
          }
        }),
    };
  }

  #tick(): void {
    this.now = Date.now();
    if (this.#ledger.closeOverdueReceptions(this.now)) {
      this.#scheduleRefresh();
    }
    if (this.isCampaignActive) {
      this.#campaign?.refresh();
    }
  }

  #scheduleRefresh(): void {
    if (this.#refreshPending) {
      return;
    }
    this.#refreshPending = true;
    setTimeout(() => {
      this.#refreshPending = false;
      this.#refresh();
    }, REFRESH_INTERVAL_MILLISECONDS);
  }

  #refresh(): void {
    const views: ConnectionView[] = [];
    for (const connection of this.#connections.values()) {
      const cached = this.#viewCache.get(connection.key);
      if (cached !== undefined && cached.revision === connection.revision) {
        views.push(cached.view);
        continue;
      }
      const view: ConnectionView = {
        key: connection.key,
        transportKind: connection.transport.kind,
        transportDescription: connection.transport.description,
        status: connection.status,
        closureMessage: connection.closureMessage,
        state: connection.state,
        duplicated: false,
      };
      this.#viewCache.set(connection.key, { revision: connection.revision, view });
      views.push(view);
    }
    this.connections = views.map((view) => {
      const identifier = view.state.identifier;
      const duplicated =
        identifier !== null &&
        view.status !== "closed" &&
        views.some(
          (other) =>
            other !== view && other.status !== "closed" && other.state.identifier === identifier,
        );
      return duplicated === view.duplicated ? view : { ...view, duplicated };
    });
    this.streamRecords = this.#stream.toArray();
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
  }
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

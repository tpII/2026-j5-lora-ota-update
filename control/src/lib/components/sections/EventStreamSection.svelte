<script lang="ts">
  import { HELP_COMMAND, LOAD_IMAGE_COMMAND, RESEND_COMMAND } from "$lib/commands/console-command.ts";
  import { lineCapacityOf } from "$lib/console/console-command-table.ts";
  import { CONSOLE_LINE_CAPACITY } from "$lib/protocol/protocol-contract.ts";
  import { TRANSPORT_LABELS } from "$lib/transports/console-transport.ts";
  import { CONSOLE_EVENT_NAMES, type ConsoleEventName } from "$lib/console/console-event.ts";
  import {
    ALL_NODES_FILTER,
    SELECTED_NODE_FILTER,
    STREAM_CAPACITY,
  } from "$lib/state/event-stream.svelte.ts";
  import { highlightJsonLine } from "$lib/console/console-line-highlighter.ts";
  import type { ConsoleRecord } from "$lib/node-session/node-connection.ts";
  import { formatClockTime, formatNumber } from "$lib/utils/format.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();

  /** Lines drawn at most; the stream keeps more for the filters. */
  const MAXIMUM_VISIBLE_RECORDS = 500;

  /** What each event is, for the event filter. */
  const EVENT_DESCRIPTIONS: { readonly [Name in ConsoleEventName]: string } = {
    boot: "arranque",
    radio: "parámetros de radio",
    wifi: "punto de acceso",
    presence: "estado de los HELLO",
    status: "estado",
    neighbor: "vecino",
    tx: "transmisión",
    hello: "HELLO recibido",
    echo_served: "eco respondido",
    echo: "eco recibido",
    echo_lost: "eco perdido",
    run_start: "comienzo de corrida",
    run_done: "fin de corrida en el emisor",
    test_rx: "paquete de corrida",
    run_end: "fin de corrida en el receptor",
    duplicate: "paquete repetido",
    drop: "paquete descartado",
    id_conflict: "identificador repetido",
    vm: "estado de la VM",
    vm_print: "salida de la VM",
    vm_fault: "falla de la VM",
    transfer: "estado de la transferencia",
    image: "imagen disponible",
    image_rejected: "imagen rechazada",
    fragment_rx: "fragmento recibido",
    burst_start: "comienzo de ráfaga",
    burst_done: "fin de ráfaga",
    report_sent: "reporte enviado",
    report_received: "reporte recibido",
    activation: "activación",
    program: "programa activo",
    error: "error",
  };

  let autoscrollPaused = $state(false);
  /** Console the operator chose by hand in «Enviar a»; null while the field follows the chosen node. */
  let manualCommandTarget = $state<string | null>(null);
  let commandText = $state("");
  let listElement = $state<HTMLElement | null>(null);

  const openConnections = $derived(panel.nodes.open);

  /**
   * The console «Enviar a» follows: the chosen node while its console is open, identified or not (a
   * node not yet identified still answers commands), else the first open console.
   */
  const followedCommandTarget = $derived.by(() => {
    const selected = panel.nodes.selected;
    return selected !== null && selected.status === "open" ? selected.key : (openConnections[0]?.key ?? "");
  });
  const commandTarget = $derived(
    manualCommandTarget !== null && openConnections.some((connection) => connection.key === manualCommandTarget)
      ? manualCommandTarget
      : followedCommandTarget,
  );

  $effect(() => {
    // A manual choice lasts while its console stays open; then the field follows the chosen node again.
    if (
      manualCommandTarget !== null &&
      !openConnections.some((connection) => connection.key === manualCommandTarget)
    ) {
      manualCommandTarget = null;
    }
  });

  /** Chosen node when the manual choice was made; not reactive on purpose. */
  let selectedKeyAtChoice: string | null = null;

  $effect(() => {
    // Choosing another node above makes «Enviar a» follow it again.
    const selectedKey = panel.nodes.selected?.key ?? null;
    if (manualCommandTarget !== null && selectedKey !== selectedKeyAtChoice) {
      manualCommandTarget = null;
    }
  });

  function chooseCommandTarget(key: string): void {
    selectedKeyAtChoice = panel.nodes.selected?.key ?? null;
    // Choosing the followed console again goes back to following the chosen node.
    manualCommandTarget = key === followedCommandTarget ? null : key;
  }

  const matchingRecords = $derived(panel.stream.matching);
  const visibleRecords = $derived(matchingRecords.slice(-MAXIMUM_VISIBLE_RECORDS));

  $effect(() => {
    if (visibleRecords.length > 0 && !autoscrollPaused && listElement !== null) {
      listElement.scrollTop = listElement.scrollHeight;
    }
  });

  function nodeLabel(connectionKey: string): string {
    const connection = panel.nodes.byKey(connectionKey);
    return connection?.state.identifier ?? connectionKey;
  }

  function kindLabel(record: ConsoleRecord): string {
    switch (record.kind) {
      case "event":
        return record.event.ev;
      case "unrecognized":
        return "no reconocido";
      case "debug":
        return "depuración";
      case "command":
        return "comando";
      case "notice":
        return "panel";
    }
  }

  function rowClass(record: ConsoleRecord): string {
    switch (record.kind) {
      case "debug":
        return "text-faint";
      case "command":
        return "text-neon bg-neon/5";
      case "notice":
        return "text-warn bg-warn/10";
      case "unrecognized":
        return "text-danger bg-danger/10";
      case "event":
        return record.event.ev === "error" ? "text-danger" : "text-ink";
    }
  }

  /** Why the node would refuse the typed line for its length, as the firmware checks it. */
  function lengthProblemOf(text: string): string | null {
    const capacity = lineCapacityOf(text);
    if (text.trim().length <= capacity) {
      return null;
    }
    return capacity === CONSOLE_LINE_CAPACITY
      ? `El nodo admite hasta ${CONSOLE_LINE_CAPACITY} caracteres por línea.`
      : `El nodo admite hasta ${capacity} caracteres en una línea de ${LOAD_IMAGE_COMMAND}.`;
  }

  const commandProblem = $derived(lengthProblemOf(commandText));

  async function sendCommand(command: string): Promise<void> {
    const text = command.trim();
    if (commandTarget === "" || text === "" || lengthProblemOf(text) !== null) {
      return;
    }
    if (await panel.sendTypedCommand(commandTarget, text)) {
      if (command === commandText) {
        commandText = "";
      }
    }
  }
</script>

<div class="flex flex-col gap-3">
  <div class="panel-card flex flex-wrap items-end gap-3">
    <label class="panel-label">
      Nodo
      <select class="panel-input" bind:value={panel.stream.nodeFilter}>
        <option value={ALL_NODES_FILTER}>Todos</option>
        <option value={SELECTED_NODE_FILTER}>
          El nodo elegido{panel.nodes.selected === null
            ? ""
            : ` (${panel.nodes.selected.state.identifier ?? panel.nodes.selected.key})`}
        </option>
        {#each panel.nodes.connections as connection (connection.key)}
          <option value={connection.key}>
            {connection.state.identifier ?? connection.key} ({TRANSPORT_LABELS[connection.transportKind]})
          </option>
        {/each}
      </select>
    </label>
    <label class="panel-label max-w-full">
      Tipo
      <select class="panel-input max-w-full" bind:value={panel.stream.kindFilter}>
        <option value="all">Todas las líneas</option>
        <option value="no-debug">Todo salvo depuración</option>
        <option value="events">Todos los eventos</option>
        {#each CONSOLE_EVENT_NAMES as name (name)}
          <option value={name}>{name} ({EVENT_DESCRIPTIONS[name]})</option>
        {/each}
        <option value="unrecognized">Objetos no reconocidos</option>
        <option value="debug">Texto de depuración</option>
        <option value="command">Comandos enviados</option>
        <option value="notice">Avisos del panel</option>
      </select>
    </label>
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" bind:checked={autoscrollPaused} />
      Pausar el desplazamiento automático
    </label>
    <button type="button" class="panel-button ml-auto" onclick={() => panel.clearStream()}>Vaciar la vista</button>
  </div>

  <div
    bind:this={listElement}
    class="h-[28rem] overflow-y-auto rounded-lg border border-line bg-surface"
    role="log"
    aria-label="Flujo de eventos"
  >
    {#if visibleRecords.length === 0}
      <p class="p-4 text-sm text-faint">
        {panel.stream.records.length === 0
          ? "Todavía no llegó ninguna línea. Las líneas de todos los nodos conectados aparecen en esta lista."
          : "Ninguna línea cumple los filtros elegidos."}
      </p>
    {:else}
      <ol class="divide-y divide-line">
        {#each visibleRecords as record (record.sequence)}
          <!-- Narrow screens: time, node and kind on one row and the line below, across the full width. -->
          <li class="grid grid-cols-[auto_auto_1fr] gap-x-2 gap-y-0.5 px-2 py-1 font-mono text-xs md:grid-cols-[6.5rem_3.5rem_6.5rem_1fr] md:py-0.5 {rowClass(record)}">
            <span class="text-faint">{formatClockTime(record.hostTime)}</span>
            <span class="font-semibold">{nodeLabel(record.connectionKey)}</span>
            <span class="truncate">{kindLabel(record)}</span>
            <span class="col-span-full break-all whitespace-pre-wrap md:col-span-1">
              {#if record.kind === "event" || record.kind === "unrecognized"}
                <!-- One line, so no white space falls between the colored segments. -->
                {#each highlightJsonLine(record.text) as segment, index (index)}<span style={segment.style}>{segment.text}</span>{/each}
              {:else}
                {record.kind === "command" ? `› ${record.text}` : record.text}
              {/if}
              {#if record.kind === "unrecognized"}
                <span class="font-sans text-muted">({record.problem})</span>
              {/if}
            </span>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
  <p class="panel-hint">
    {visibleRecords.length === 1 ? "Se muestra" : "Se muestran"} {formatNumber(visibleRecords.length)} de {formatNumber(matchingRecords.length)} {matchingRecords.length === 1 ? "línea que cumple" : "líneas que cumplen"}
    los filtros; el panel guarda las últimas {formatNumber(STREAM_CAPACITY)} líneas de todos los nodos.
  </p>

  <form
    class="panel-card flex flex-wrap items-end gap-3"
    onsubmit={(event) => {
      event.preventDefault();
      void sendCommand(commandText);
    }}
  >
    <label class="panel-label max-w-full">
      Enviar a
      <select
        class="panel-input max-w-full"
        value={commandTarget}
        disabled={openConnections.length === 0}
        onchange={(event) => chooseCommandTarget(event.currentTarget.value)}
      >
        {#each openConnections as connection (connection.key)}
          <option value={connection.key}>
            {connection.state.identifier ?? connection.key}{connection.key === panel.nodes.selected?.key
              ? " (el nodo elegido)"
              : ""}
          </option>
        {/each}
      </select>
    </label>
    <label class="panel-label min-w-0 flex-1 basis-64">
      Comando
      <input
        class="panel-input font-mono {commandProblem !== null ? 'panel-input-invalid' : ''}"
        type="text"
        placeholder="por ejemplo: radio sf 9 bw 500"
        autocomplete="off"
        spellcheck="false"
        bind:value={commandText}
      />
    </label>
    <button type="submit" class="panel-button panel-button-primary" disabled={commandTarget === "" || commandText.trim() === "" || commandProblem !== null}>
      Enviar
    </button>
    <div class="flex flex-wrap gap-2">
      {#each [HELP_COMMAND, RESEND_COMMAND] as quickCommand (quickCommand)}
        <button
          type="button"
          class="panel-button font-mono"
          disabled={commandTarget === ""}
          onclick={() => sendCommand(quickCommand)}
        >
          {quickCommand}
        </button>
      {/each}
    </div>
    {#if commandProblem !== null}
      <p class="panel-error-text w-full">{commandProblem}</p>
    {/if}
  </form>
</div>

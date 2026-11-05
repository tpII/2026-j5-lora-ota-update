<script lang="ts">
  import { MAXIMUM_COMMAND_LENGTH, HELP_COMMAND, RESEND_COMMAND } from "$lib/console/console-command.ts";
  import { CONSOLE_EVENT_NAMES } from "$lib/console/console-event.ts";
  import { highlightJsonLine } from "$lib/console/console-line-highlighter.ts";
  import type { ConsoleRecord } from "$lib/nodes/node-connection.ts";
  import { formatClockTime, formatNumber } from "$lib/utils/format.ts";
  import { EVENT_DESCRIPTIONS, TRANSPORT_LABELS } from "$lib/utils/labels.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel, active }: { panel: ControlPanel; active: boolean } = $props();

  /** Lines drawn at most; the stream keeps more for the filters. */
  const MAXIMUM_VISIBLE_RECORDS = 500;

  /** Node filter value that follows the node chosen above, whichever it is at each moment. */
  const SELECTED_NODE_FILTER = "selected";

  type KindFilter = "all" | "no-debug" | "events" | "debug" | "command" | "notice" | "unrecognized" | (typeof CONSOLE_EVENT_NAMES)[number];

  let nodeFilter = $state("all");
  let kindFilter = $state<KindFilter>("all");
  let autoscrollPaused = $state(false);
  /** Console the operator chose by hand in «Enviar a»; null while the field follows the chosen node. */
  let manualCommandTarget = $state<string | null>(null);
  let commandText = $state("");
  let listElement = $state<HTMLElement | null>(null);

  const openConnections = $derived(panel.connections.filter((connection) => connection.status === "open"));

  /**
   * The console «Enviar a» follows: the chosen node while its console is open, identified or not (a
   * node not yet identified still answers commands), else the first open console.
   */
  const followedCommandTarget = $derived.by(() => {
    const selected = panel.selectedConnection;
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
    const selectedKey = panel.selectedConnection?.key ?? null;
    if (manualCommandTarget !== null && selectedKey !== selectedKeyAtChoice) {
      manualCommandTarget = null;
    }
  });

  function chooseCommandTarget(key: string): void {
    selectedKeyAtChoice = panel.selectedConnection?.key ?? null;
    // Choosing the followed console again goes back to following the chosen node.
    manualCommandTarget = key === followedCommandTarget ? null : key;
  }

  function matchesFilters(record: ConsoleRecord): boolean {
    if (nodeFilter === SELECTED_NODE_FILTER) {
      if (record.connectionKey !== panel.selectedConnection?.key) {
        return false;
      }
    } else if (nodeFilter !== "all" && record.connectionKey !== nodeFilter) {
      return false;
    }
    switch (kindFilter) {
      case "all":
        return true;
      case "no-debug":
        return record.kind !== "debug";
      case "events":
        return record.kind === "event";
      case "debug":
      case "command":
      case "notice":
      case "unrecognized":
        return record.kind === kindFilter;
      default:
        return record.kind === "event" && record.event.ev === kindFilter;
    }
  }

  const matchingRecords = $derived(active ? panel.streamRecords.filter(matchesFilters) : []);
  const visibleRecords = $derived(matchingRecords.slice(-MAXIMUM_VISIBLE_RECORDS));

  $effect(() => {
    // Follow the newest line unless the operator paused the scrolling.
    if (visibleRecords.length > 0 && !autoscrollPaused && listElement !== null) {
      listElement.scrollTop = listElement.scrollHeight;
    }
  });

  function nodeLabel(connectionKey: string): string {
    const connection = panel.connection(connectionKey);
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

  const commandProblem = $derived(
    commandText.length > MAXIMUM_COMMAND_LENGTH
      ? `El nodo admite hasta ${MAXIMUM_COMMAND_LENGTH} caracteres por línea.`
      : null,
  );

  async function sendCommand(command: string): Promise<void> {
    const text = command.trim();
    if (commandTarget === "" || text === "" || text.length > MAXIMUM_COMMAND_LENGTH) {
      return;
    }
    if (await panel.sendCommand(commandTarget, text)) {
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
      <select class="panel-input" bind:value={nodeFilter}>
        <option value="all">Todos</option>
        <option value={SELECTED_NODE_FILTER}>
          El nodo elegido{panel.selectedConnection === null
            ? ""
            : ` (${panel.selectedConnection.state.identifier ?? panel.selectedConnection.key})`}
        </option>
        {#each panel.connections as connection (connection.key)}
          <option value={connection.key}>
            {connection.state.identifier ?? connection.key} ({TRANSPORT_LABELS[connection.transportKind]})
          </option>
        {/each}
      </select>
    </label>
    <label class="panel-label max-w-full">
      Tipo
      <select class="panel-input max-w-full" bind:value={kindFilter}>
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
        {panel.streamRecords.length === 0
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
    los filtros; el panel guarda las últimas {formatNumber(3000)} líneas de todos los nodos.
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
            {connection.state.identifier ?? connection.key}{connection.key === panel.selectedConnection?.key
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
    <button type="submit" class="panel-button-primary" disabled={commandTarget === "" || commandText.trim() === "" || commandProblem !== null}>
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

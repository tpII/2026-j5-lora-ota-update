<script lang="ts">
  import {
    MAXIMUM_COMMAND_LENGTH,
    HELP_COMMAND,
    RADIO_QUERY_COMMAND,
    RESEND_COMMAND,
    STATUS_COMMAND,
  } from "$lib/console/console-command.ts";
  import { CONSOLE_EVENT_NAMES } from "$lib/console/console-event.ts";
  import type { ConsoleRecord } from "$lib/nodes/node-connection.ts";
  import { formatClockTime, formatNumber } from "$lib/utils/format.ts";
  import { EVENT_DESCRIPTIONS, TRANSPORT_LABELS } from "$lib/utils/labels.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel, active }: { panel: ControlPanel; active: boolean } = $props();

  /** Lines drawn at most; the stream keeps more for the filters. */
  const MAXIMUM_VISIBLE_RECORDS = 500;

  type KindFilter = "all" | "events" | "debug" | "command" | "notice" | "unrecognized" | (typeof CONSOLE_EVENT_NAMES)[number];

  let nodeFilter = $state("all");
  let kindFilter = $state<KindFilter>("all");
  let showDebugText = $state(true);
  let autoscrollPaused = $state(false);
  let commandTarget = $state("");
  let commandText = $state("");
  let listElement = $state<HTMLElement | null>(null);

  const openConnections = $derived(panel.connections.filter((connection) => connection.status === "open"));

  $effect(() => {
    if (!openConnections.some((connection) => connection.key === commandTarget)) {
      commandTarget = openConnections[0]?.key ?? "";
    }
  });

  function matchesFilters(record: ConsoleRecord): boolean {
    if (nodeFilter !== "all" && record.connectionKey !== nodeFilter) {
      return false;
    }
    if (record.kind === "debug" && !showDebugText) {
      return false;
    }
    switch (kindFilter) {
      case "all":
        return true;
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
        return "text-slate-400";
      case "command":
        return "text-sky-800 bg-sky-50";
      case "notice":
        return "text-amber-800 bg-amber-50";
      case "unrecognized":
        return "text-red-800 bg-red-50";
      case "event":
        return record.event.ev === "error" ? "text-red-700" : "text-slate-800";
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
        {#each panel.connections as connection (connection.key)}
          <option value={connection.key}>
            {connection.state.identifier ?? connection.key} ({TRANSPORT_LABELS[connection.transportKind]})
          </option>
        {/each}
      </select>
    </label>
    <label class="panel-label">
      Tipo
      <select class="panel-input" bind:value={kindFilter}>
        <option value="all">Todas las líneas</option>
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
      <input type="checkbox" bind:checked={showDebugText} />
      Mostrar texto de depuración
    </label>
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" bind:checked={autoscrollPaused} />
      Pausar el desplazamiento automático
    </label>
    <button type="button" class="panel-button ml-auto" onclick={() => panel.clearStream()}>Vaciar la vista</button>
  </div>

  <div
    bind:this={listElement}
    class="h-[28rem] overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm"
    role="log"
    aria-label="Flujo de eventos"
  >
    {#if visibleRecords.length === 0}
      <p class="p-4 text-sm text-slate-500">
        {panel.streamRecords.length === 0
          ? "Todavía no llegó ninguna línea. Las líneas de todos los nodos conectados aparecen en esta lista."
          : "Ninguna línea cumple los filtros elegidos."}
      </p>
    {:else}
      <ol class="divide-y divide-slate-100">
        {#each visibleRecords as record (record.sequence)}
          <!-- Narrow screens: time, node and kind on one row and the line below, across the full width. -->
          <li class="grid grid-cols-[auto_auto_1fr] gap-x-2 gap-y-0.5 px-2 py-1 font-mono text-xs md:grid-cols-[6.5rem_3.5rem_6.5rem_1fr] md:py-0.5 {rowClass(record)}">
            <span class="text-slate-400">{formatClockTime(record.hostTime)}</span>
            <span class="font-semibold">{nodeLabel(record.connectionKey)}</span>
            <span class="truncate">{kindLabel(record)}</span>
            <span class="col-span-full break-all whitespace-pre-wrap md:col-span-1">
              {record.kind === "command" ? `› ${record.text}` : record.text}
              {#if record.kind === "unrecognized"}
                <span class="font-sans italic">({record.problem})</span>
              {/if}
            </span>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
  <p class="panel-hint">
    Se muestran {formatNumber(visibleRecords.length)} de {formatNumber(matchingRecords.length)} líneas que cumplen
    los filtros; el panel guarda las últimas {formatNumber(3000)} líneas de todos los nodos.
  </p>

  <form
    class="panel-card flex flex-wrap items-end gap-3"
    onsubmit={(event) => {
      event.preventDefault();
      void sendCommand(commandText);
    }}
  >
    <label class="panel-label">
      Enviar a
      <select class="panel-input" bind:value={commandTarget} disabled={openConnections.length === 0}>
        {#each openConnections as connection (connection.key)}
          <option value={connection.key}>{connection.state.identifier ?? connection.key}</option>
        {/each}
      </select>
    </label>
    <label class="panel-label min-w-64 flex-1">
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
      {#each [HELP_COMMAND, STATUS_COMMAND, RADIO_QUERY_COMMAND, RESEND_COMMAND] as quickCommand (quickCommand)}
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

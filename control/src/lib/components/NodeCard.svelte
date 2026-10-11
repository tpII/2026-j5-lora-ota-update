<script lang="ts">
  import { STATUS_COMMAND, buildWifiCommand } from "$lib/console/console-command.ts";
  import { estimateUptime } from "$lib/nodes/node-state.ts";
  import {
    formatDuration,
    formatFrequency,
    formatModulation,
    formatNumber,
    formatPower,
  } from "$lib/utils/format.ts";
  import {
    CONNECTION_STATUS_LABELS,
    TRANSPORT_LABELS,
    countWithNoun,
    describeErrorReason,
    describeLnaMode,
  } from "$lib/utils/labels.ts";
  import type { ConnectionView, ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel, connection }: { panel: ControlPanel; connection: ConnectionView } = $props();

  const node = $derived(connection.state);
  const open = $derived(connection.status === "open");
  const senderRun = $derived(
    node.senderRun !== null && node.senderRun.completion === null ? node.senderRun : null,
  );
  const activeReceptions = $derived(node.receptions.filter((reception) => reception.end === null));
  const lastError = $derived(node.errors.at(-1) ?? null);
  const uptime = $derived(estimateUptime(node, panel.now));
  const statusBadgeClass = $derived(
    connection.status === "open"
      ? "bg-emerald-100 text-emerald-800"
      : connection.status === "closed"
        ? "bg-slate-200 text-slate-700"
        : "bg-amber-100 text-amber-800",
  );

  function toggleWifi(): void {
    if (node.wifi?.state === "on") {
      if (
        connection.transportKind === "websocket" &&
        !window.confirm("Apagar el punto de acceso corta esta conexión WiFi. ¿Continuar?")
      ) {
        return;
      }
      void panel.sendCommand(connection.key, buildWifiCommand("off"));
    } else {
      void panel.sendCommand(connection.key, buildWifiCommand("on"));
    }
  }
</script>

<article class="panel-card flex flex-col gap-3" aria-label="Nodo {node.identifier ?? 'sin identificar'}">
  <header class="flex items-start justify-between gap-2">
    <div>
      <h2 class="font-mono text-lg font-semibold">
        {node.identifier ?? "Identificando…"}
        {#if node.model !== null}
          <span class="panel-badge ml-1 bg-sky-100 font-sans text-sky-800">{node.model}</span>
        {/if}
      </h2>
      <p class="text-xs text-slate-500">
        {TRANSPORT_LABELS[connection.transportKind]} · {connection.transportDescription}
      </p>
    </div>
    <span class="panel-badge {statusBadgeClass}">{CONNECTION_STATUS_LABELS[connection.status]}</span>
  </header>

  {#if connection.duplicated}
    <p class="panel-note">
      Este nodo también está conectado por otro transporte: sus líneas llegan dos veces.
    </p>
  {/if}
  {#if connection.status === "closed" && connection.closureMessage !== null}
    <p class="panel-error-text">{connection.closureMessage}</p>
  {/if}

  <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
    <dt class="text-slate-500">Época</dt>
    <dd>{node.epoch ?? "—"}</dd>

    <dt class="text-slate-500">Firmware</dt>
    <dd>
      {#if node.firmwareVersion !== null}
        {node.firmwareVersion} · protocolo {node.protocolVersion}
        {#if node.networkKey === "custom"}· clave de red propia{/if}
      {:else}
        <span class="text-slate-500">se conoce con el próximo arranque</span>
      {/if}
    </dd>

    <dt class="text-slate-500">Radio</dt>
    <dd>
      {#if node.radio !== null}
        {formatModulation(node.radio)} · {formatFrequency(node.radio.freq)}<br />
        {formatPower(node.radio.power)} en la antena · {describeLnaMode(node.radio.lna)}
      {:else}
        —
      {/if}
    </dd>

    <dt class="text-slate-500">WiFi</dt>
    <dd>
      {#if node.wifi !== null}
        {node.wifi.ssid}
        {node.wifi.state === "on" ? "encendido" : "apagado"} · canal {node.wifi.channel} ·
        {countWithNoun(node.wifi.clients, "cliente", "clientes")}
      {:else}
        —
      {/if}
    </dd>

    <dt class="text-slate-500">HELLO</dt>
    <dd>
      {#if node.presence === null}
        —
      {:else if node.presence.state === "on"}
        activos
      {:else}
        <span class="text-amber-700">suspendidos</span>
        {#if node.presence.remaining !== null}
          <span class="text-slate-500">
            (vuelven solos en {formatDuration(node.presence.remaining * 1000 - (panel.now - node.presence.hostTime))})
          </span>
        {/if}
      {/if}
    </dd>

    <dt class="text-slate-500">Estado</dt>
    <dd>
      {#if node.counters !== null}
        TX {formatNumber(node.counters.transmitted)} · RX {formatNumber(node.counters.received)} · memoria
        libre {formatNumber(node.counters.freeHeap)} B
        {#if node.counters.droppedLines > 0}
          · <span class="text-amber-700">{formatNumber(node.counters.droppedLines)} líneas descartadas</span>
        {/if}
        <span class="text-slate-500">(status de hace {formatDuration(panel.now - node.counters.hostTime)})</span>
      {:else}
        —
      {/if}
      {#if uptime !== null}
        <br /><span class="text-slate-500">Encendido hace {formatDuration(uptime)}</span>
      {/if}
    </dd>

    <dt class="text-slate-500">Vecinos</dt>
    <dd>
      {node.neighbors.length === 0 ? "ninguno" : node.neighbors.map((neighbor) => neighbor.id).join(", ")}
    </dd>

    {#if senderRun !== null || activeReceptions.length > 0}
      <dt class="text-slate-500">Corrida</dt>
      <dd>
        {#if senderRun !== null}
          Transmite la corrida {senderRun.run}: {formatNumber(senderRun.transmitted)} de {formatNumber(senderRun.count)}
        {/if}
        {#each activeReceptions as reception (`${reception.source}:${reception.run}`)}
          <div>
            Recibe la corrida {reception.run} de {reception.source}: {formatNumber(reception.received)} de
            {formatNumber(reception.count)}
          </div>
        {/each}
      </dd>
    {/if}

    {#if lastError !== null}
      <dt class="text-slate-500">Último error</dt>
      <dd class="text-red-700">
        {lastError.command === "" ? "(sin comando)" : lastError.command}: {lastError.reason}
        <span class="text-slate-500">({describeErrorReason(lastError.reason)})</span>
      </dd>
    {/if}
  </dl>

  <footer class="mt-auto flex flex-wrap gap-2">
    {#if open}
      <button type="button" class="panel-button" onclick={() => panel.sendCommand(connection.key, STATUS_COMMAND)}>
        Consultar estado
      </button>
      <button type="button" class="panel-button" disabled={node.wifi === null} onclick={toggleWifi}>
        {node.wifi?.state === "on" ? "Apagar WiFi" : "Encender WiFi"}
      </button>
      <button type="button" class="panel-button-danger" onclick={() => panel.disconnect(connection.key)}>
        Desconectar
      </button>
    {:else if connection.status === "closed"}
      <button type="button" class="panel-button" onclick={() => panel.remove(connection.key)}>Quitar</button>
    {/if}
  </footer>
</article>

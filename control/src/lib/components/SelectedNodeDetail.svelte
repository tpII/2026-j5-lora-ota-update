<script lang="ts">
  import { STATUS_COMMAND, buildWifiCommand } from "$lib/console/console-command.ts";
  import { estimateUptime } from "$lib/nodes/node-state.ts";
  import {
    formatDuration,
    formatFrequency,
    formatImageVersion,
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
      ? "bg-ok/10 text-ok"
      : connection.status === "closed"
        ? "bg-line text-muted"
        : "bg-warn/10 text-warn",
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

<section class="panel-card-neon flex flex-col gap-4" aria-labelledby="selected-node-title">
  <header class="-mx-4 -mt-4 flex flex-wrap items-center justify-between gap-3 rounded-t-lg border-b border-neon/25 bg-neon/5 px-4 py-3">
    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <h2 id="selected-node-title" class="panel-oled px-2 py-0.5 text-lg">
        {node.identifier ?? "Identificando…"}
      </h2>
      {#if node.model !== null}
        <span class="panel-badge bg-neon/10 text-neon">{node.model}</span>
      {/if}
      <span class="panel-badge {statusBadgeClass}">{CONNECTION_STATUS_LABELS[connection.status]}</span>
      <p class="font-mono text-[0.6875rem] tracking-wider text-faint">
        {TRANSPORT_LABELS[connection.transportKind]} · {connection.transportDescription}
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
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
    </div>
  </header>

  {#if connection.duplicated}
    <p class="panel-note">
      Este nodo también está conectado por otro transporte: sus líneas llegan dos veces.
    </p>
  {/if}
  {#if connection.status === "closed" && connection.closureMessage !== null}
    <p class="panel-error-text">{connection.closureMessage}</p>
  {/if}

  <dl class="grid gap-x-6 gap-y-3 text-sm tabular-nums sm:grid-cols-2 lg:grid-cols-4">
    <div class="panel-rule pt-2">
      <dt class="font-mono text-[0.6875rem] tracking-wider text-faint uppercase">Época</dt>
      <dd class="mt-0.5 text-ink tabular-nums">{node.epoch ?? "—"}</dd>
    </div>

    <div class="panel-rule pt-2">
      <dt class="font-mono text-[0.6875rem] tracking-wider text-faint uppercase">Firmware</dt>
      <dd class="mt-0.5 text-ink">
        {#if node.firmwareVersion !== null}
          {node.firmwareVersion} · protocolo {node.protocolVersion}
          {#if node.networkKey === "custom"}· clave de red propia{/if}
        {:else}
          se conoce con el próximo arranque
        {/if}
      </dd>
    </div>

    <div class="panel-rule pt-2">
      <dt class="font-mono text-[0.6875rem] tracking-wider text-faint uppercase">Clave del operador</dt>
      <dd class="mt-0.5 text-ink">
        {#if node.operatorKey === null}
          se conoce con el próximo arranque
        {:else}
          verifica con {node.operatorKey === "default" ? "la clave pública por defecto" : "una clave pública propia"}
        {/if}
      </dd>
    </div>

    <div class="panel-rule pt-2">
      <dt class="font-mono text-[0.6875rem] tracking-wider text-faint uppercase">Radio</dt>
      <dd class="mt-0.5 text-ink tabular-nums">
        {#if node.radio !== null}
          {formatModulation(node.radio)} · {formatFrequency(node.radio.freq)}<br />
          {formatPower(node.radio.power)} en la antena · {describeLnaMode(node.radio.lna)}
        {:else}
          —
        {/if}
      </dd>
    </div>

    <div class="panel-rule pt-2">
      <dt class="font-mono text-[0.6875rem] tracking-wider text-faint uppercase">WiFi</dt>
      <dd class="mt-0.5 text-ink">
        {#if node.wifi !== null}
          {node.wifi.ssid}
          {node.wifi.state === "on" ? "encendido" : "apagado"} · canal {node.wifi.channel} ·
          {countWithNoun(node.wifi.clients, "cliente", "clientes")}
        {:else}
          —
        {/if}
      </dd>
    </div>

    <div class="panel-rule pt-2">
      <dt class="font-mono text-[0.6875rem] tracking-wider text-faint uppercase">HELLO</dt>
      <dd class="mt-0.5 text-ink tabular-nums">
        {#if node.presence === null}
          —
        {:else if node.presence.state === "on"}
          activos
        {:else}
          <span class="text-warn">suspendidos</span>
          {#if node.presence.remaining !== null}
            (vuelven solos en {formatDuration(node.presence.remaining * 1000 - (panel.now - node.presence.hostTime))})
          {/if}
        {/if}
      </dd>
    </div>

    <div class="panel-rule pt-2">
      <dt class="font-mono text-[0.6875rem] tracking-wider text-faint uppercase">Estado</dt>
      <dd class="mt-0.5 text-ink tabular-nums">
        {#if node.counters !== null}
          TX {formatNumber(node.counters.transmitted)} · RX {formatNumber(node.counters.received)} · memoria libre
          {formatNumber(node.counters.freeHeap)} B
          {#if node.counters.droppedLines > 0}
            · <span class="text-warn">{formatNumber(node.counters.droppedLines)} líneas descartadas</span>
          {/if}
          <br />status de hace {formatDuration(panel.now - node.counters.hostTime)}
        {:else}
          —
        {/if}
        {#if uptime !== null}
          <br />Encendido hace {formatDuration(uptime)}
        {/if}
      </dd>
    </div>

    <div class="panel-rule pt-2">
      <dt class="font-mono text-[0.6875rem] tracking-wider text-faint uppercase">Versiones</dt>
      <dd class="mt-0.5 text-ink tabular-nums">
        activa <span class="font-mono">{formatImageVersion(node.activeVersion)}</span><br />
        disponible <span class="font-mono">{formatImageVersion(node.availableVersion)}</span>
        {#if node.imageReception !== null}
          <br />recibe <span class="font-mono">{node.imageReception.version}</span>
        {/if}
      </dd>
    </div>

    <div class="panel-rule pt-2">
      <dt class="font-mono text-[0.6875rem] tracking-wider text-faint uppercase">Vecinos</dt>
      <dd class="mt-0.5 font-mono text-ink">
        {node.neighbors.length === 0 ? "ninguno" : node.neighbors.map((neighbor) => neighbor.id).join(", ")}
      </dd>
    </div>

    {#if senderRun !== null || activeReceptions.length > 0}
      <div class="panel-rule pt-2">
        <dt class="font-mono text-[0.6875rem] tracking-wider text-faint uppercase">Corrida</dt>
        <dd class="mt-0.5 text-ink tabular-nums">
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
      </div>
    {/if}

    {#if lastError !== null}
      <div class="panel-rule pt-2 sm:col-span-2">
        <dt class="font-mono text-[0.6875rem] tracking-wider text-faint uppercase">Último error</dt>
        <dd class="mt-0.5 text-danger">
          {lastError.command === "" ? "(sin comando)" : lastError.command}: {lastError.reason}
          <span class="text-faint">({describeErrorReason(lastError.reason)})</span>
          {#if lastError.detail !== null}
            <br /><span class="text-muted">{lastError.detail}</span>
          {/if}
          <br /><span class="text-faint">hace {formatDuration(panel.now - lastError.hostTime)}</span>
        </dd>
      </div>
    {/if}
  </dl>
</section>

<script lang="ts">
  import { STATUS_COMMAND } from "$lib/console/console-command.ts";
  import { isNeighborExpired, neighborAge } from "$lib/nodes/node-state.ts";
  import { formatDuration, formatNumber, formatRssi, formatSnr } from "$lib/utils/format.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();

  const identifiedConnections = $derived(
    panel.connections.filter((connection) => connection.state.identifier !== null),
  );
</script>

<div class="flex flex-col gap-3">
  <p class="panel-hint">
    Cada nodo emite un HELLO cada 10 s aproximadamente, con la calidad con que escucha a cada uno de sus
    vecinos. Un vecino sale de la tabla del nodo después de 60 s sin paquetes suyos. El comando status
    lista los vecinos que el nodo conoce en ese momento.
  </p>

  {#if identifiedConnections.length === 0}
    <div class="panel-card text-sm text-slate-600">No hay nodos identificados.</div>
  {/if}

  {#each identifiedConnections as connection (connection.key)}
    {@const node = connection.state}
    <div class="panel-card flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="panel-section-title">
          Vecinos de <span class="font-mono">{node.identifier}</span>
          <span class="text-sm font-normal text-slate-500">({node.model ?? "modelo desconocido"})</span>
        </h3>
        <button
          type="button"
          class="panel-button"
          disabled={connection.status !== "open"}
          onclick={() => panel.sendCommand(connection.key, STATUS_COMMAND)}
        >
          Consultar estado
        </button>
      </div>

      {#if node.neighbors.length === 0}
        <p class="text-sm text-slate-600">Sin vecinos registrados todavía.</p>
      {:else}
        <div class="overflow-x-auto">
          <table class="panel-table">
            <thead>
              <tr>
                <th>Vecino</th>
                <th>Placa</th>
                <th>RSSI</th>
                <th>SNR</th>
                <th>Error de frecuencia</th>
                <th>Último paquete</th>
                <th>HELLO recibidos</th>
                <th>Paquetes que transmitió</th>
                <th>Programa</th>
              </tr>
            </thead>
            <tbody>
              {#each node.neighbors as neighbor (neighbor.id)}
                {@const expired = isNeighborExpired(neighbor, panel.now)}
                <tr class={expired ? "text-slate-400" : ""}>
                  <td class="font-mono font-semibold">{neighbor.id}</td>
                  <td>{neighbor.model}</td>
                  <td class="whitespace-nowrap">{formatRssi(neighbor.rssi)}</td>
                  <td class="whitespace-nowrap">{formatSnr(neighbor.snr)}</td>
                  <td class="whitespace-nowrap">
                    {neighbor.frequencyError === null ? "—" : `${formatNumber(neighbor.frequencyError)} Hz`}
                  </td>
                  <td class="whitespace-nowrap">
                    hace {formatDuration(neighborAge(neighbor, panel.now))}
                    {#if expired}<span class="panel-badge bg-slate-100 text-slate-600">vencido</span>{/if}
                  </td>
                  <td>{formatNumber(neighbor.helloCount)}</td>
                  <td>{formatNumber(neighbor.transmitted)}</td>
                  <td>{neighbor.version === 0 ? "ninguno" : formatNumber(neighbor.version)}</td>
                </tr>
                <tr class={expired ? "text-slate-400" : ""}>
                  <td></td>
                  <td colspan="8" class="text-xs text-slate-600">
                    {#if neighbor.reportedNeighbors === null}
                      Sin HELLO recibido: no se sabe cómo escucha {neighbor.id} a sus vecinos.
                    {:else if neighbor.reportedNeighbors.length === 0}
                      {neighbor.id} no informó vecinos en su último HELLO.
                    {:else}
                      Cómo escucha {neighbor.id} a sus vecinos:
                      {#each neighbor.reportedNeighbors as report, index (report.id)}
                        {#if index > 0}<span class="mx-1">·</span>{/if}
                        <span class="whitespace-nowrap">
                          <span class="font-mono font-semibold">{report.id}</span>
                          {formatRssi(report.rssi)}, {formatSnr(report.snr)}
                        </span>
                      {/each}
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/each}
</div>

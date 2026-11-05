<script lang="ts">
  import { isNeighborExpired, neighborAge } from "$lib/nodes/node-state.ts";
  import {
    formatDuration,
    formatImageVersion,
    formatNumber,
    formatRssi,
    formatSnr,
  } from "$lib/utils/format.ts";
  import { VM_FAULT_LABELS } from "$lib/utils/labels.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  /**
   * `onEchoRequest` receives a neighbor of the chosen node whose row the operator picked for an
   * echo; without it the rows carry no echo button.
   */
  let {
    panel,
    onEchoRequest,
  }: { panel: ControlPanel; onEchoRequest?: (identifier: string) => void } = $props();

  const chosenKey = $derived(panel.selectedIdentifiedConnection?.key ?? null);

  /** Every identified node, the chosen one first. */
  const identifiedConnections = $derived(
    panel.connections
      .filter((connection) => connection.state.identifier !== null)
      .toSorted(
        (first, second) => Number(second.key === chosenKey) - Number(first.key === chosenKey),
      ),
  );
</script>

<div class="flex flex-col gap-3">
  {#if identifiedConnections.length === 0}
    <div class="panel-card text-sm text-muted">No hay nodos identificados.</div>
  {/if}

  {#each identifiedConnections as connection (connection.key)}
    {@const node = connection.state}
    {@const chosen = connection.key === chosenKey}
    {@const withEchoButton = chosen && onEchoRequest !== undefined}
    <div class="{chosen ? 'panel-card-neon' : 'panel-card'} flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="panel-section-title">
          Vecinos de <span class="font-mono">{node.identifier}</span>
          <span class="text-sm font-normal text-faint">({node.model ?? "placa desconocida"})</span>
        </h3>
      </div>

      {#if node.neighbors.length === 0}
        <p class="text-sm text-muted">Sin vecinos registrados todavía.</p>
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
                <th>Versión activa</th>
                <th>Versión disponible</th>
                <th>VM</th>
                {#if withEchoButton}<th><span class="sr-only">Eco</span></th>{/if}
              </tr>
            </thead>
            <tbody>
              {#each node.neighbors as neighbor (neighbor.id)}
                {@const expired = isNeighborExpired(neighbor, panel.now)}
                <tr class={expired ? "text-faint" : ""}>
                  <td class="font-mono font-semibold">{neighbor.id}</td>
                  <td>{neighbor.model}</td>
                  <td class="whitespace-nowrap">{formatRssi(neighbor.rssi)}</td>
                  <td class="whitespace-nowrap">{formatSnr(neighbor.snr)}</td>
                  <td class="whitespace-nowrap">
                    {neighbor.frequencyError === null ? "—" : `${formatNumber(neighbor.frequencyError)} Hz`}
                  </td>
                  <td class="whitespace-nowrap">
                    hace {formatDuration(neighborAge(neighbor, panel.now))}
                    {#if expired}<span class="panel-badge bg-raised text-muted" title="Sin paquetes suyos en los últimos 60 s"
                        >vencido</span
                      >{/if}
                  </td>
                  <td>{formatNumber(neighbor.helloCount)}</td>
                  <td>{formatNumber(neighbor.transmitted)}</td>
                  <td class="font-mono">{formatImageVersion(neighbor.version)}</td>
                  <td class="font-mono">{formatImageVersion(neighbor.availableVersion)}</td>
                  <td class="min-w-36 text-xs {neighbor.vmFault !== null || neighbor.vmFailing ? 'text-danger' : ''}">
                    {neighbor.vmFault === null ? "—" : VM_FAULT_LABELS[neighbor.vmFault]}
                    {#if neighbor.vmFailing}· el último tick falló{/if}
                  </td>
                  {#if withEchoButton}
                    <td>
                      <button
                        type="button"
                        class="panel-button px-2 py-0.5"
                        aria-label="Preparar un eco a {neighbor.id}"
                        title="Preparar un eco a {neighbor.id}"
                        onclick={() => onEchoRequest?.(neighbor.id)}
                      >
                        Eco
                      </button>
                    </td>
                  {/if}
                </tr>
                <tr class={expired ? "text-faint" : ""}>
                  <td></td>
                  <td colspan={withEchoButton ? 11 : 10} class="text-xs text-muted">
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
      {#if chosen}
        <p class="panel-hint">Un HELLO cada 10 s aproximadamente; un vecino vence a los 60 s sin paquetes suyos.</p>
      {/if}
    </div>
  {/each}
</div>

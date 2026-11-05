<script lang="ts">
  import MeasurementExportAction from "./MeasurementExportAction.svelte";
  import MeasurementSheetForm from "./MeasurementSheetForm.svelte";
  import type { UpdatePhase } from "$lib/measurements/update-metrics.ts";
  import { formatNumber, formatShortClockTime } from "$lib/utils/format.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel, active }: { panel: ControlPanel; active: boolean } = $props();

  /** Null follows the last version loaded. */
  let chosenVersion = $state<number | null>(null);

  const versions = $derived(panel.updateVersions);
  const version = $derived(
    chosenVersion !== null && versions.includes(chosenVersion) ? chosenVersion : (versions.at(-1) ?? null),
  );
  // Computed again every second while the section is visible: the journal can hold many events.
  const metrics = $derived.by(() => {
    if (!active || version === null) {
      return null;
    }
    void panel.now;
    void panel.journalSize;
    return panel.measureUpdate(version);
  });

  function formatSeconds(milliseconds: number | null | undefined): string {
    return milliseconds === null || milliseconds === undefined ? "—" : `${formatNumber(milliseconds / 1000, 3)} s`;
  }

  function sinceLoad(hostTime: number | null): string {
    return metrics === null || hostTime === null ? "—" : formatSeconds(hostTime - metrics.loadHostTime);
  }

  function describePhase(phase: UpdatePhase | null): string {
    if (phase === null) {
      return "sin orden de activación";
    }
    if (phase.endHostTime !== null) {
      return formatSeconds(phase.milliseconds);
    }
    return phase.pendingNodes.length === 0 ? "en curso" : `en curso; faltan ${phase.pendingNodes.join(", ")}`;
  }
</script>

<div class="flex flex-col gap-3">
  <div class="panel-card flex flex-col gap-3">
    <h3 class="panel-section-title">Métricas de la actualización</h3>
    <p class="panel-hint">
      M1, M2 y M3 se calculan con los eventos registrados desde que el panel envió load_image. Los nodos del grafo son
      todos los que nombran esos eventos. M2 cuenta todos los paquetes, HELLO incluidos, según los contadores tx de los
      HELLO y de status; los fragmentos y los reportes se cuentan solo en los nodos conectados.
    </p>

    {#if versions.length === 0}
      <p class="text-sm text-muted">
        El panel todavía no cargó ninguna imagen desde que se descartó el registro de mediciones.
      </p>
    {:else}
      <label class="panel-label w-fit">
        Actualización
        <select
          class="panel-input font-mono"
          value={version}
          onchange={(event) => (chosenVersion = Number(event.currentTarget.value))}
        >
          {#each versions.toReversed() as value (value)}
            <option {value}>{value}</option>
          {/each}
        </select>
      </label>

      {#if metrics !== null}
        {@const { convergence, efficiency } = metrics}
        <p class="text-sm">
          Carga a las {formatShortClockTime(metrics.loadHostTime)}
          {#if metrics.origin !== null}en <span class="font-mono">{metrics.origin}</span>, el nodo origen{/if}
          {#if metrics.activateHostTime !== null}; orden de activación a las {formatShortClockTime(metrics.activateHostTime)}{/if}.
          Grafo: {metrics.nodes.join(", ") || "sin nodos"}.
        </p>

        <dl class="grid gap-3 sm:grid-cols-3">
          <div class="rounded-md border border-line p-3">
            <dt class="text-xs text-faint">M1, convergencia</dt>
            <dd class="text-lg font-semibold">{describePhase(convergence.total)}</dd>
            <dd class="text-xs text-muted">distribución: {describePhase(convergence.distribution)}</dd>
            <dd class="text-xs text-muted">activación: {describePhase(convergence.activation)}</dd>
          </div>
          <div class="rounded-md border border-line p-3">
            <dt class="text-xs text-faint">M2, eficiencia de la inundación</dt>
            <dd class="text-lg font-semibold">
              {efficiency.ratio === null ? "—" : `${formatNumber(efficiency.ratio, 2)} veces el mínimo`}
            </dd>
            <dd class="text-xs text-muted">
              {formatNumber(efficiency.transmitted)} paquetes transmitidos; mínimo {formatNumber(efficiency.minimum)}
              ({formatNumber(efficiency.fragmentCount)} fragmentos × {Math.max(0, metrics.nodes.length - 1)})
            </dd>
            <dd class="text-xs text-muted">
              transferencia: {formatNumber(efficiency.transferFrames.fragments)} fragmentos y
              {formatNumber(efficiency.transferFrames.reports)} reportes{efficiency.transferFrames.complete
                ? ""
                : `, contados solo en ${efficiency.transferFrames.countedNodes.join(", ") || "ningún nodo"}`}
            </dd>
          </div>
          <div class="rounded-md border border-line p-3">
            <dt class="text-xs text-faint">M3, pérdida y reparación</dt>
            {#if metrics.receivers.length === 0}
              <dd class="text-sm text-muted">sin receptores</dd>
            {:else}
              {#each metrics.receivers as receiver (receiver.id)}
                <dd class="text-sm">
                  <span class="font-mono">{receiver.id}</span>:
                  {receiver.missingPercent === null ? "—" : `${formatNumber(receiver.missingPercent, 1)} %`} en el
                  primer reporte, {receiver.repairRounds === null ? "—" : receiver.repairRounds}
                  {receiver.repairRounds === 1 ? "ronda" : "rondas"} de reparación
                </dd>
              {/each}
            {/if}
          </div>
        </dl>

        <div class="overflow-x-auto">
          <table class="panel-table">
            <thead>
              <tr>
                <th>Nodo</th>
                <th>Disponible desde la carga</th>
                <th>Activa desde la carga</th>
                <th>Paquetes transmitidos</th>
                <th>Primer reporte</th>
                <th>Rondas de reparación</th>
                <th>Reportes vistos</th>
                <th>Recepción</th>
              </tr>
            </thead>
            <tbody>
              {#each metrics.nodes as id (id)}
                {@const times = convergence.nodes.find((node) => node.id === id)}
                {@const transmission = efficiency.nodes.find((node) => node.id === id)}
                {@const receiver = metrics.receivers.find((node) => node.id === id)}
                <tr>
                  <td class="font-mono font-semibold">
                    {id}
                    {#if id === metrics.origin}<span class="panel-badge ml-1 bg-neon/10 font-sans text-neon">origen</span>{/if}
                  </td>
                  <td>{sinceLoad(times?.availableHostTime ?? null)}</td>
                  <td>{sinceLoad(times?.activeHostTime ?? null)}</td>
                  <td>
                    {formatNumber(transmission?.transmitted)}
                    {#if transmission?.startsAfterLoad}
                      <span class="text-xs text-warn">(sin contador previo a la carga)</span>
                    {/if}
                  </td>
                  <td class="text-xs">
                    {#if receiver?.firstReport != null}
                      faltaban {receiver.firstReport.missing.length} de {receiver.firstReport.fragmentCount}
                    {:else if receiver !== undefined && receiver.missingPercent === 0}
                      sin pérdidas
                    {:else}
                      —
                    {/if}
                  </td>
                  <td>{receiver?.repairRounds ?? "—"}</td>
                  <td>{receiver === undefined ? "—" : receiver.observedReports}</td>
                  <td class="text-xs">
                    {receiver?.image == null
                      ? "—"
                      : `${receiver.image.fragments} fragmentos en ${formatNumber(receiver.image.durationMilliseconds)} ms`}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      <MeasurementExportAction
        {panel}
        test="update"
        files="metadata.json (con las órdenes load_image y activate del panel), events.jsonl (todos los eventos del registro) y summary.csv (una fila por receptor de cada actualización cargada desde que se descartó el registro)"
        fileCount="tres"
        exportFiles={(description) => panel.exportUpdates(description)}
      />
    {/if}
  </div>

  {#if versions.length > 0}
    <MeasurementSheetForm {panel} />
  {/if}
</div>

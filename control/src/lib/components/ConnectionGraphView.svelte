<script lang="ts">
  import { onDestroy } from "svelte";
  import BoardThumbnail from "./BoardThumbnail.svelte";
  import { STATUS_COMMAND } from "$lib/console/console-command.ts";
  import type { GraphLink, GraphNode, LinkQuality } from "$lib/nodes/connection-graph.ts";
  import { GraphForceModel, type GraphPlacements, type NodePlacement } from "$lib/nodes/graph-force-model.ts";
  import { browserStorage, loadPinnedPositions, savePinnedPositions } from "$lib/nodes/graph-pins.ts";
  import { formatDuration, formatImageVersion, formatRssi, formatSnr } from "$lib/utils/format.ts";
  import { GRAPH_NODE_SOURCE_LABELS, VM_FAULT_LABELS } from "$lib/utils/labels.ts";
  import type { ControlPanel } from "$lib/state/control-panel.svelte.ts";

  let { panel }: { panel: ControlPanel } = $props();

  type Hovered =
    | { readonly kind: "node"; readonly id: string }
    | { readonly kind: "link"; readonly key: string };

  /** Pointer travel, in pixels, beyond which a press on a node becomes a drag and not a click. */
  const DRAG_THRESHOLD = 4;
  /** Keyboard step to move a node, in pixels; with Shift, four times as much. */
  const KEYBOARD_STEP = 12;
  const TOOLTIP_WIDTH = 256;
  const TOOLTIP_MARGIN = 8;

  const graph = $derived(panel.connectionGraph);
  const selectedId = $derived(panel.selectedConnection?.state.identifier ?? null);
  const nodesById = $derived(new Map(graph.nodes.map((node) => [node.id, node])));
  /** Open console of each identified node; a closed duplicate never takes its place. */
  const connectionKeys = $derived(
    new Map(
      panel.identifiedConnections.map((connection) => [connection.state.identifier ?? "", connection.key]),
    ),
  );

  const openConnections = $derived(panel.connections.filter((connection) => connection.status === "open"));

  /** Asks every open console for its state; a node not yet identified answers and identifies itself. */
  function queryEveryNode(): void {
    for (const connection of openConnections) {
      void panel.sendCommand(connection.key, STATUS_COMMAND);
    }
  }

  let width = $state(0);
  let height = $state(0);
  let placements = $state.raw<GraphPlacements>(new Map());
  let pinCount = $state(0);

  // Without local storage (site data blocked), the pins last until the page closes.
  const storage = browserStorage();
  const initialPins = storage === null ? new Map() : loadPinnedPositions(storage);
  pinCount = initialPins.size;
  const model = new GraphForceModel({
    pins: initialPins,
    onChange: (changed) => (placements = changed),
    onPinsChange: (pins) => {
      if (storage !== null) {
        savePinnedPositions(storage, pins);
      }
      pinCount = pins.size;
    },
  });
  onDestroy(() => {
    model.stop();
    cancelPendingSelection();
  });

  $effect(() => {
    if (width > 0 && height > 0) {
      model.setSize(width, height);
    }
  });
  $effect(() => {
    model.update(graph);
  });

  /**
   * Nodes with their places, in the order of the graph (by identifier). The order stays fixed while
   * nodes move: reordering the elements during a drag would release the pointer capture.
   */
  const placedNodes = $derived(
    graph.nodes
      .map((node) => ({ node, placement: placements.get(node.id) }))
      .filter((entry): entry is { node: GraphNode; placement: NodePlacement } => entry.placement !== undefined),
  );

  // The pointer and the keyboard each choose a target; the pointer wins while it is over one.
  let pointerTarget = $state<Hovered | null>(null);
  let focusTarget = $state<Hovered | null>(null);
  let dragging = $state<string | null>(null);
  const hovered = $derived(dragging === null ? (pointerTarget ?? focusTarget) : null);

  /** The press in progress on a node, until it turns into a drag or a click. */
  let press: { id: string; pointerId: number; startX: number; startY: number; moved: boolean } | null = null;
  /** Set when a press ended as a drag, so that the click that follows does not select. */
  let suppressClick = false;
  let frame: HTMLDivElement | undefined = $state();

  /** Opens the tooltip on focus only from the keyboard; a click or a drag also focuses the button. */
  function focusFromKeyboard(event: FocusEvent, target: Hovered): void {
    if ((event.currentTarget as HTMLElement).matches(":focus-visible")) {
      focusTarget = target;
    }
  }

  function linkKey(link: GraphLink): string {
    return `${link.first}:${link.second}`;
  }

  function midpoint(link: GraphLink): { x: number; y: number } | null {
    const first = placements.get(link.first);
    const second = placements.get(link.second);
    return first === undefined || second === undefined
      ? null
      : { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  }

  /** The weaker of the two directions, which limits the link. */
  function weakerRssi(link: GraphLink): number | null {
    const values = [link.firstHearsSecond, link.secondHearsFirst]
      .filter((quality): quality is LinkQuality => quality !== null)
      .map((quality) => quality.rssi);
    return values.length === 0 ? null : Math.min(...values);
  }

  /** An integer with a typographic minus sign. */
  function formatSignedInteger(value: number): string {
    const rounded = Math.round(value);
    return rounded < 0 ? `−${-rounded}` : String(rounded);
  }

  function hasActivationPending(node: GraphNode): boolean {
    return (
      node.availableVersion !== null &&
      node.activeVersion !== null &&
      node.availableVersion > node.activeVersion
    );
  }

  function hasVmTrouble(node: GraphNode): boolean {
    return node.vmFault !== null || node.vmFailing === true;
  }

  function describeMachine(node: GraphNode): string {
    if (node.source === "neighbor_list") {
      return "—";
    }
    const fault = node.vmFault === null ? "sin fallas" : VM_FAULT_LABELS[node.vmFault];
    return node.vmFailing === true ? `${fault}; el último tick falló` : fault;
  }

  function describeHearing(quality: LinkQuality | null): string {
    return quality === null ? "sin datos" : `${formatRssi(quality.rssi)} · ${formatSnr(quality.snr)}`;
  }

  function describeLastHeard(node: GraphNode): string {
    if (node.connected) {
      return "consola abierta";
    }
    return node.lastHeardHostTime === null ? "—" : `hace ${formatDuration(panel.now - node.lastHeardHostTime)}`;
  }

  /** The link between the chosen node and `id`, if they are neighbors. */
  function linkWithSelected(id: string): GraphLink | undefined {
    return graph.links.find(
      (link) => (link.first === selectedId && link.second === id) || (link.second === selectedId && link.first === id),
    );
  }

  function hearingFrom(link: GraphLink, listener: string): LinkQuality | null {
    return link.first === listener ? link.firstHearsSecond : link.secondHearsFirst;
  }

  /** The model name as the node shape shows it: "V2", "V4" or "?". */
  function modelGlyph(node: GraphNode): string {
    return node.model === null ? "?" : node.model === "V2" ? "V2" : "V4";
  }

  function select(id: string): void {
    const key = connectionKeys.get(id);
    if (key !== undefined) {
      panel.selectedKey = key;
    }
  }

  function pointInFrame(event: PointerEvent): { x: number; y: number } {
    const box = frame?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  }

  function startPress(event: PointerEvent, id: string): void {
    // Only the main button, and one pointer at a time: a second finger does not take over.
    if (event.button !== 0 || press !== null) {
      return;
    }
    // A drag that produced no click (a touch drag, a cancelled pointer) left no flag behind.
    suppressClick = false;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    press = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
  }

  function movePress(event: PointerEvent): void {
    if (press === null || press.pointerId !== event.pointerId) {
      return;
    }
    if (!press.moved && Math.hypot(event.clientX - press.startX, event.clientY - press.startY) < DRAG_THRESHOLD) {
      return;
    }
    press.moved = true;
    dragging = press.id;
    const point = pointInFrame(event);
    model.moveTo(press.id, point.x, point.y);
  }

  function endPress(event: PointerEvent): void {
    if (press === null || press.pointerId !== event.pointerId) {
      return;
    }
    if (press.moved) {
      model.endMove();
      // Only a release produces the click to swallow; a cancelled pointer produces none.
      suppressClick = event.type === "pointerup";
    }
    press = null;
    dragging = null;
  }

  // The node being dragged left the graph, and with it its button and the pointer capture.
  $effect(() => {
    if (dragging !== null && !graph.nodes.some((node) => node.id === dragging)) {
      press = null;
      dragging = null;
    }
  });

  /** The selection before the first click of a double click, which only releases the node. */
  /**
   * A double click releases a pinned node, so the first click on a pinned node waits for the second
   * before choosing it: choosing and going back would throw away what the sections keep for the node
   * chosen before. A free node is chosen at once.
   */
  const DOUBLE_CLICK_WINDOW_MILLISECONDS = 250;
  let pendingSelection: ReturnType<typeof setTimeout> | null = null;

  function cancelPendingSelection(): void {
    if (pendingSelection !== null) {
      clearTimeout(pendingSelection);
      pendingSelection = null;
    }
  }

  function activate(event: MouseEvent, id: string): void {
    // A click from Enter or Space (detail 0) never follows a drag.
    const suppressed = suppressClick && event.detail !== 0;
    suppressClick = false;
    cancelPendingSelection();
    if (suppressed || event.detail > 1) {
      return;
    }
    if (event.detail === 1 && placements.get(id)?.pinned === true) {
      pendingSelection = setTimeout(() => {
        pendingSelection = null;
        select(id);
      }, DOUBLE_CLICK_WINDOW_MILLISECONDS);
    } else {
      select(id);
    }
  }

  function releaseWithDoubleClick(id: string): void {
    cancelPendingSelection();
    model.release(id);
  }

  function dismissTooltip(event: KeyboardEvent): void {
    if (event.key === "Escape" && hovered !== null) {
      pointerTarget = null;
      focusTarget = null;
    }
  }

  function moveWithKeyboard(event: KeyboardEvent, id: string): void {
    const step = event.shiftKey ? KEYBOARD_STEP * 4 : KEYBOARD_STEP;
    const offsets: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const offset = offsets[event.key];
    const placement = placements.get(id);
    if (offset !== undefined && placement !== undefined) {
      event.preventDefault();
      model.moveTo(id, placement.x + offset[0], placement.y + offset[1]);
      model.endMove();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      model.release(id);
    }
  }

  /** Where the tooltip of the hovered element anchors, kept inside the drawing. */
  const tooltipAnchor = $derived.by(() => {
    if (hovered === null) {
      return null;
    }
    let point: { x: number; y: number } | null = null;
    if (hovered.kind === "node") {
      point = placements.get(hovered.id) ?? null;
    } else {
      const key = hovered.key;
      const link = graph.links.find((candidate) => linkKey(candidate) === key);
      point = link === undefined ? null : midpoint(link);
    }
    if (point === null) {
      return null;
    }
    const left = Math.min(
      Math.max(point.x - TOOLTIP_WIDTH / 2, TOOLTIP_MARGIN),
      width - TOOLTIP_WIDTH - TOOLTIP_MARGIN,
    );
    return { x: point.x, y: point.y, left, below: point.y < height / 2 };
  });
</script>

{#snippet nodeTooltip(node: GraphNode)}
  {@const selectedLink = node.id === selectedId ? undefined : linkWithSelected(node.id)}
  <div class="flex items-start gap-3">
    <BoardThumbnail model={node.model} class="w-24" />
    <div class="min-w-0">
      <p class="font-pixel text-sm text-neon text-shadow-neon">{node.id}</p>
      <p class="text-faint">{node.model ?? "Placa desconocida"}</p>
      <p class="text-faint">
        {node.connected ? "Conectado al panel" : `Datos de ${GRAPH_NODE_SOURCE_LABELS[node.source]}`}
      </p>
    </div>
  </div>
  <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
    <dt class="font-medium text-ink">Activa</dt>
    <dd class="font-mono text-muted tabular-nums">{formatImageVersion(node.activeVersion)}</dd>
    <dt class="font-medium text-ink">Disponible</dt>
    <dd class="font-mono text-muted tabular-nums">
      {formatImageVersion(node.availableVersion)}
      {#if hasActivationPending(node)}<span class="font-sans text-warn">· sin activar</span>{/if}
    </dd>
    <dt class="font-medium text-ink">VM</dt>
    <dd class={hasVmTrouble(node) ? "text-danger" : "text-muted"}>{describeMachine(node)}</dd>
    {#if selectedLink !== undefined && selectedId !== null}
      <dt class="font-medium text-ink">Lo escucha</dt>
      <dd class="text-muted tabular-nums">
        <span class="font-mono">{selectedId}</span>: {describeHearing(hearingFrom(selectedLink, selectedId))}
      </dd>
      <dt class="font-medium text-ink">Escucha</dt>
      <dd class="text-muted tabular-nums">
        <span class="font-mono">{selectedId}</span>: {describeHearing(hearingFrom(selectedLink, node.id))}
      </dd>
    {/if}
    <dt class="font-medium text-ink">Último dato</dt>
    <dd class="text-muted tabular-nums">{describeLastHeard(node)}</dd>
  </dl>
  <p class="mt-2 text-faint">
    {placements.get(node.id)?.pinned ? "Fijado: doble clic o Supr lo suelta." : "Arrastrarlo lo fija donde se suelta."}
    {#if node.connected && node.id !== selectedId}Un clic lo elige.{/if}
  </p>
{/snippet}

{#snippet linkTooltip(link: GraphLink)}
  <p class="font-mono font-semibold text-ink">{link.first} – {link.second}</p>
  <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
    <dt class="font-medium text-ink"><span class="font-mono">{link.first}</span> escucha</dt>
    <dd class="text-muted tabular-nums">{describeHearing(link.firstHearsSecond)}</dd>
    <dt class="font-medium text-ink"><span class="font-mono">{link.second}</span> escucha</dt>
    <dd class="text-muted tabular-nums">{describeHearing(link.secondHearsFirst)}</dd>
  </dl>
{/snippet}

<svelte:window onkeydown={dismissTooltip} />

<section class="flex flex-col gap-2" aria-labelledby="connection-graph-title">
  <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
    <h2 id="connection-graph-title" class="panel-section-title">Grafo de conexiones</h2>
    <div class="flex flex-wrap gap-2">
      <button type="button" class="panel-button" disabled={openConnections.length === 0} onclick={queryEveryNode}>
        Consultar el estado de todos los nodos conectados
      </button>
      <button type="button" class="panel-button" disabled={pinCount === 0} onclick={() => model.releaseAll()}>
        Soltar todos los nodos
      </button>
    </div>
  </div>
  <p class="panel-hint">
    Los nodos se acomodan solos: un enlace es más largo cuanto más débil es su RSSI, en dBm, el número que lleva.
    Arrastrar un nodo, o moverlo con las flechas, lo fija donde se suelta, para copiar la disposición física de las
    placas; el panel recuerda esas posiciones.
  </p>
  <ul role="list" class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
    <li class="flex items-center gap-1.5">
      <span class="size-3 rounded-[0.25rem] bg-neon-shade-strong ring-2 shadow-neon ring-neon" aria-hidden="true"></span>Nodo
      elegido
    </li>
    <li class="flex items-center gap-1.5">
      <span class="size-3 rounded-[0.25rem] bg-neon-shade ring-1 ring-neon/80" aria-hidden="true"></span>Conectado al
      panel
    </li>
    <li class="flex items-center gap-1.5">
      <span class="size-3 rounded-full ring-1 ring-line-strong" aria-hidden="true"></span>Escuchado por la radio
    </li>
    <li class="flex items-center gap-1.5">
      <span class="size-1.5 rounded-full bg-warn" aria-hidden="true"></span>Versión disponible sin activar
    </li>
    <li class="flex items-center gap-1.5">
      <span class="size-1.5 rounded-full bg-danger" aria-hidden="true"></span>Falla de la VM
    </li>
    <li class="flex items-center gap-1.5">
      <span class="w-4 border-t border-dashed border-neon/60" aria-hidden="true"></span>Un sentido sin datos
    </li>
    <li class="flex items-center gap-1.5">
      <span class="size-1.5 rotate-45 bg-neon-bright" aria-hidden="true"></span>Fijado en su lugar
    </li>
  </ul>

  <div
    bind:this={frame}
    bind:clientWidth={width}
    bind:clientHeight={height}
    class="relative isolate h-[32rem] select-none sm:h-[28rem]"
  >
    <!-- A faint glow under the graph, so it floats on the grid of the page. -->
    <div
      class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgb(92_225_240/0.08),transparent_65%)]"
      aria-hidden="true"
    ></div>

    {#if graph.nodes.length === 0}
      <div class="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
        {#if panel.connections.length === 0}
          <p class="text-sm font-medium text-ink">Sin nodos conectados</p>
          <p class="panel-hint">Conectar un nodo por USB o por WiFi desde la caja con el signo + de arriba.</p>
        {:else if panel.connections.some((connection) => connection.status === "open")}
          <p class="text-sm font-medium text-ink">El nodo todavía no se identificó</p>
          <p class="panel-hint">Aparece en el grafo con su próximo arranque o al consultar su estado.</p>
        {:else if panel.connections.some((connection) => connection.status === "opening")}
          <p class="text-sm font-medium text-ink">Conectando con el nodo…</p>
          <p class="panel-hint">El grafo aparece cuando la conexión abre y el nodo se identifica.</p>
        {:else}
          <p class="text-sm font-medium text-ink">Sin conexiones abiertas</p>
          <p class="panel-hint">Volver a conectar un nodo desde la caja con el signo + de arriba.</p>
        {/if}
      </div>
    {/if}

    <svg
      class="pointer-events-none absolute inset-0 size-full overflow-visible drop-shadow-[0_0_3px_rgb(92_225_240/0.7)]"
      aria-hidden="true"
    >
      {#each graph.links as link (linkKey(link))}
        {@const first = placements.get(link.first)}
        {@const second = placements.get(link.second)}
        {#if first !== undefined && second !== undefined}
          {@const highlighted =
            hovered !== null &&
            ((hovered.kind === "link" && hovered.key === linkKey(link)) ||
              (hovered.kind === "node" && (hovered.id === link.first || hovered.id === link.second)))}
          <line
            x1={first.x}
            y1={first.y}
            x2={second.x}
            y2={second.y}
            stroke-width={highlighted ? 2.5 : 1.5}
            stroke-dasharray={link.firstHearsSecond === null || link.secondHearsFirst === null ? "5 4" : undefined}
            class={highlighted ? "stroke-neon-bright" : "stroke-neon/55"}
          />
        {/if}
      {/each}
    </svg>

    {#each placedNodes as { node, placement } (node.id)}
      {@const isSelected = node.id === selectedId}
      {@const selectable = node.connected && !isSelected && connectionKeys.has(node.id)}
      <button
        type="button"
        aria-label="Nodo {node.id}{selectable ? ', conectado; Intro lo elige' : ''}"
        aria-current={isSelected ? "true" : undefined}
        aria-describedby={hovered?.kind === "node" && hovered.id === node.id ? "graph-tooltip" : undefined}
        class="group absolute top-(--y) left-(--x) z-1 flex w-max -translate-1/2 touch-none flex-col items-center gap-1 rounded-md {dragging ===
        node.id
          ? 'cursor-grabbing'
          : 'cursor-grab'}"
        style="--x: {placement.x.toFixed(1)}px; --y: {placement.y.toFixed(1)}px"
        onpointerdown={(event) => startPress(event, node.id)}
        onpointermove={movePress}
        onpointerup={endPress}
        onpointercancel={endPress}
        onlostpointercapture={endPress}
        onclick={(event) => activate(event, node.id)}
        ondblclick={() => releaseWithDoubleClick(node.id)}
        onkeydown={(event) => moveWithKeyboard(event, node.id)}
        onpointerenter={() => (pointerTarget = { kind: "node", id: node.id })}
        onpointerleave={() => (pointerTarget = null)}
        onfocus={(event) => focusFromKeyboard(event, { kind: "node", id: node.id })}
        onblur={() => (focusTarget = null)}
      >
        <span
          class="relative flex items-center justify-center font-pixel {isSelected
            ? 'size-14 rounded-xl bg-neon-shade-strong text-sm text-neon-bright shadow-neon ring-2 ring-neon text-shadow-neon'
            : node.connected
              ? 'size-11 rounded-lg bg-neon-shade text-xs text-neon ring-1 shadow-neon-soft ring-neon/80 group-hover:shadow-neon group-hover:ring-neon'
              : 'size-10 rounded-full bg-sunken text-xs text-muted ring-1 ring-line-strong group-hover:text-neon group-hover:ring-neon/60'}"
        >
          {modelGlyph(node)}
          {#if hasActivationPending(node)}
            <span class="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-warn text-warn shadow-[0_0_6px_currentColor]" aria-hidden="true"
            ></span>
          {/if}
          {#if hasVmTrouble(node)}
            <span
              class="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-danger text-danger shadow-[0_0_6px_currentColor]"
              aria-hidden="true"
            ></span>
          {/if}
          {#if placement.pinned}
            <span class="absolute -top-1 -left-1 size-1.5 rotate-45 bg-neon-bright" aria-hidden="true"></span>
          {/if}
        </span>
        <span class="rounded-sm bg-screen/90 px-1 font-pixel text-xs {isSelected ? 'text-neon text-shadow-neon' : 'text-ink'}">
          {node.id}
        </span>
      </button>
    {/each}

    {#each graph.links as link (linkKey(link))}
      {@const middle = midpoint(link)}
      {@const rssi = weakerRssi(link)}
      {#if middle !== null && rssi !== null}
        <button
          type="button"
          class="absolute top-(--y) left-(--x) -translate-1/2 cursor-default rounded-sm bg-screen px-1.5 py-0.5 font-mono text-[0.6875rem] text-neon tabular-nums ring-1 ring-neon/35 hover:text-neon-bright hover:shadow-neon"
          style="--x: {middle.x.toFixed(1)}px; --y: {middle.y.toFixed(1)}px"
          aria-label="Enlace {link.first} – {link.second}, {formatSignedInteger(rssi)} dBm"
          aria-describedby={hovered?.kind === "link" && hovered.key === linkKey(link) ? "graph-tooltip" : undefined}
          onpointerenter={() => (pointerTarget = { kind: "link", key: linkKey(link) })}
          onpointerleave={() => (pointerTarget = null)}
          onfocus={(event) => focusFromKeyboard(event, { kind: "link", key: linkKey(link) })}
          onblur={() => (focusTarget = null)}
        >
          {formatSignedInteger(rssi)}
        </button>
      {/if}
    {/each}

    {#if hovered !== null && tooltipAnchor !== null}
      <div
        id="graph-tooltip"
        role="tooltip"
        class="pointer-events-none absolute top-(--y) left-(--left) z-10 w-64 rounded-md bg-sunken/95 p-3 text-xs shadow-neon-soft ring-1 ring-neon/40 backdrop-blur
          {tooltipAnchor.below ? 'mt-12' : '-mt-12 -translate-y-full'}"
        style="--left: {tooltipAnchor.left.toFixed(1)}px; --y: {tooltipAnchor.y.toFixed(1)}px"
      >
        {#if hovered.kind === "node"}
          {@const node = nodesById.get(hovered.id)}
          {#if node !== undefined}{@render nodeTooltip(node)}{/if}
        {:else}
          {@const key = hovered.key}
          {@const link = graph.links.find((candidate) => linkKey(candidate) === key)}
          {#if link !== undefined}{@render linkTooltip(link)}{/if}
        {/if}
      </div>
    {/if}
  </div>
</section>

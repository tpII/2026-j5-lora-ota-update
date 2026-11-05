/**
 * Force-directed placement of the connection graph with d3-force: linked nodes attract each
 * other, every pair repels and a weak pull keeps the drawing centered, so the graph settles in an
 * organic shape. A link is longer the weaker its RSSI. The operator can drag a node: it stays
 * pinned where it is dropped, with the pin saved through `graph-pins.ts`, and the rest of the
 * graph rearranges around it.
 */
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import type { ConnectionGraph, GraphLink } from "./connection-graph.ts";
import type { PinnedPosition, PinnedPositions } from "./graph-pins.ts";

/** Where a node is drawn, in pixels from the top left corner of the drawing. */
export interface NodePlacement {
  readonly x: number;
  readonly y: number;
  readonly pinned: boolean;
}

export type GraphPlacements = ReadonlyMap<NodeIdentifier, NodePlacement>;

interface ForceNode extends SimulationNodeDatum {
  readonly id: NodeIdentifier;
}

interface ForceLink extends SimulationLinkDatum<ForceNode> {
  readonly rssi: number | null;
}

export interface GraphForceModelOptions {
  /** Called with the new placements after every step of the simulation. */
  readonly onChange: (placements: GraphPlacements) => void;
  /** Called with the pins whenever the operator pins or releases a node. */
  readonly onPinsChange: (pins: PinnedPositions) => void;
  readonly pins: PinnedPositions;
  /** False in tests: the simulation then only advances through `step()`. */
  readonly running?: boolean;
}

/** Distance kept between a node and the border of the drawing, in pixels. */
const BORDER_MARGIN = 36;
/** Radius that no other node enters, in pixels. */
const COLLISION_RADIUS = 40;
const STRONGEST_RSSI = -40;
const WEAKEST_RSSI = -120;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function linkKey(link: GraphLink): string {
  return `${link.first}:${link.second}`;
}

/** The weaker direction of a link, which limits it; null when neither end reported it. */
function weakerRssi(link: GraphLink): number | null {
  const values = [link.firstHearsSecond?.rssi, link.secondHearsFirst?.rssi].filter(
    (value): value is number => value !== undefined,
  );
  return values.length === 0 ? null : Math.min(...values);
}

export class GraphForceModel {
  readonly #simulation: Simulation<ForceNode, ForceLink>;
  readonly #nodes = new Map<NodeIdentifier, ForceNode>();
  readonly #pins: Map<NodeIdentifier, PinnedPosition>;
  readonly #options: GraphForceModelOptions;
  #topology = "";
  /** RSSI of every link, in 5 dB steps, so that the noise of each HELLO does not move the graph. */
  #linkWeights = "";
  #width = 0;
  #height = 0;
  /** The node that a drag is moving, until `endMove()`. */
  #moving: NodeIdentifier | null = null;

  constructor(options: GraphForceModelOptions) {
    this.#options = options;
    this.#pins = new Map(options.pins);
    this.#simulation = forceSimulation<ForceNode, ForceLink>([])
      .force(
        "link",
        forceLink<ForceNode, ForceLink>([])
          .id((node) => node.id)
          .distance((link) => this.#linkDistance(link.rssi))
          .strength(0.6),
      )
      .force("charge", forceManyBody<ForceNode>().strength(-420))
      .force("collision", forceCollide<ForceNode>(COLLISION_RADIUS))
      .force("x", forceX<ForceNode>(0).strength(0.05))
      .force("y", forceY<ForceNode>(0).strength(0.07))
      .on("tick", () => this.#publish());
    if (options.running === false) {
      this.#simulation.stop();
    }
  }

  /** Sets the size of the drawing, in pixels; pinned nodes keep their relative place. */
  setSize(width: number, height: number): void {
    if (width === this.#width && height === this.#height) {
      return;
    }
    const firstSize = this.#width === 0 || this.#height === 0;
    this.#width = width;
    this.#height = height;
    // Nodes that arrived before the drawing had a size started around the origin.
    if (firstSize) {
      for (const node of this.#nodes.values()) {
        node.x = (node.x ?? 0) + width / 2;
        node.y = (node.y ?? 0) + height / 2;
      }
    }
    this.#simulation.force<ReturnType<typeof forceX<ForceNode>>>("x")?.x(width / 2);
    this.#simulation.force<ReturnType<typeof forceY<ForceNode>>>("y")?.y(height / 2);
    for (const node of this.#nodes.values()) {
      this.#applyPin(node);
    }
    // Link distances depend on the size.
    this.#simulation.force("link", this.#simulation.force("link") ?? null);
    this.#reheat(0.5);
  }

  /**
   * Takes the graph of the moment. Nodes keep their positions from one call to the next; the
   * simulation only heats up again when nodes or links appear or disappear.
   */
  update(graph: ConnectionGraph): void {
    const topology = [
      graph.nodes.map((node) => node.id).join(","),
      graph.links.map((link) => linkKey(link)).join(","),
    ].join("|");
    const linkWeights = graph.links
      .map((link) => {
        const rssi = weakerRssi(link);
        return rssi === null ? "?" : String(Math.round(rssi / 5));
      })
      .join(",");
    if (topology === this.#topology) {
      if (linkWeights !== this.#linkWeights) {
        // Setting the links again makes the link force recompute every distance.
        this.#linkWeights = linkWeights;
        this.#setLinks(graph);
        this.#reheat(0.3);
      }
      return;
    }
    this.#topology = topology;
    this.#linkWeights = linkWeights;

    const present = new Set(graph.nodes.map((node) => node.id));
    for (const id of this.#nodes.keys()) {
      if (!present.has(id)) {
        this.#nodes.delete(id);
      }
    }
    for (const graphNode of graph.nodes) {
      if (!this.#nodes.has(graphNode.id)) {
        this.#nodes.set(graphNode.id, this.#newNode(graphNode.id, graph));
      }
    }
    if (this.#moving !== null && !this.#nodes.has(this.#moving)) {
      // The node being dragged left the graph: the drag ends here.
      this.endMove();
    }
    this.#simulation.nodes([...this.#nodes.values()]);
    this.#setLinks(graph);
    this.#reheat(0.8);
    this.#publish();
  }

  /** Moves a node to a point of the drawing and pins it there. Call `endMove()` when done. */
  moveTo(id: NodeIdentifier, x: number, y: number): void {
    const node = this.#nodes.get(id);
    if (node === undefined || this.#width === 0 || this.#height === 0) {
      return;
    }
    node.fx = clamp(x, BORDER_MARGIN, this.#width - BORDER_MARGIN);
    node.fy = clamp(y, BORDER_MARGIN, this.#height - BORDER_MARGIN);
    this.#pins.set(id, { x: node.fx / this.#width, y: node.fy / this.#height });
    this.#moving = id;
    this.#simulation.alphaTarget(0.3);
    this.#restart();
    this.#publish();
  }

  /** Ends a move: the graph cools down and the pin is saved. */
  endMove(): void {
    this.#moving = null;
    this.#simulation.alphaTarget(0);
    this.#options.onPinsChange(new Map(this.#pins));
  }

  /** Frees a pinned node, which goes back to the forces. */
  release(id: NodeIdentifier): void {
    const node = this.#nodes.get(id);
    if (!this.#pins.delete(id) || node === undefined) {
      return;
    }
    node.fx = null;
    node.fy = null;
    this.#options.onPinsChange(new Map(this.#pins));
    this.#reheat(0.5);
  }

  /** Frees every node, including those of nodes that are not in the graph now. */
  releaseAll(): void {
    this.#pins.clear();
    for (const node of this.#nodes.values()) {
      node.fx = null;
      node.fy = null;
    }
    this.#options.onPinsChange(new Map(this.#pins));
    this.#reheat(1);
  }

  /** Advances the simulation by hand; for tests. */
  step(count: number): void {
    this.#simulation.tick(count);
    this.#publish();
  }

  stop(): void {
    this.#simulation.stop();
  }

  #setLinks(graph: ConnectionGraph): void {
    const links: ForceLink[] = graph.links
      .filter((link) => this.#nodes.has(link.first) && this.#nodes.has(link.second))
      .map((link) => ({ source: link.first, target: link.second, rssi: weakerRssi(link) }));
    this.#simulation
      .force<ReturnType<typeof forceLink<ForceNode, ForceLink>>>("link")
      ?.links(links);
  }

  /** True while a drag holds the simulation warm; for tests. */
  get isMoving(): boolean {
    return this.#moving !== null;
  }

  #linkDistance(rssi: number | null): number {
    const base = Math.max(Math.min(this.#width, this.#height), 240);
    const weakness =
      rssi === null ? 0.5 : clamp((STRONGEST_RSSI - rssi) / (STRONGEST_RSSI - WEAKEST_RSSI), 0, 1);
    return base * (0.24 + 0.2 * weakness);
  }

  /** A new node starts next to a node it is linked to, or at the middle of the drawing. */
  #newNode(id: NodeIdentifier, graph: ConnectionGraph): ForceNode {
    const neighbor = graph.links
      .map((link) => (link.first === id ? link.second : link.second === id ? link.first : null))
      .map((other) => (other === null ? undefined : this.#nodes.get(other)))
      .find((other) => other?.x !== undefined && other.y !== undefined);
    // A fixed spread by order of arrival, so that two new nodes never start on the same point.
    const angle = this.#nodes.size * 2.399963;
    const spread = 24 + 6 * this.#nodes.size;
    const originX = neighbor?.x ?? this.#width / 2;
    const originY = neighbor?.y ?? this.#height / 2;
    const node: ForceNode = {
      id,
      x: originX + spread * Math.cos(angle),
      y: originY + spread * Math.sin(angle),
    };
    this.#applyPin(node);
    return node;
  }

  #applyPin(node: ForceNode): void {
    const pin = this.#pins.get(node.id);
    if (pin !== undefined && this.#width > 0 && this.#height > 0) {
      node.fx = clamp(pin.x * this.#width, BORDER_MARGIN, this.#width - BORDER_MARGIN);
      node.fy = clamp(pin.y * this.#height, BORDER_MARGIN, this.#height - BORDER_MARGIN);
      node.x = node.fx;
      node.y = node.fy;
    }
  }

  #reheat(alpha: number): void {
    this.#simulation.alpha(Math.max(this.#simulation.alpha(), alpha));
    this.#restart();
  }

  #restart(): void {
    if (this.#options.running !== false) {
      this.#simulation.restart();
    }
  }

  /** Keeps the free nodes inside the drawing and reports every position. */
  #publish(): void {
    const placements = new Map<NodeIdentifier, NodePlacement>();
    for (const node of this.#nodes.values()) {
      if (this.#width > 0 && this.#height > 0) {
        node.x = clamp(node.x ?? 0, BORDER_MARGIN, this.#width - BORDER_MARGIN);
        node.y = clamp(node.y ?? 0, BORDER_MARGIN, this.#height - BORDER_MARGIN);
      }
      placements.set(node.id, {
        x: node.x ?? 0,
        y: node.y ?? 0,
        pinned: this.#pins.has(node.id),
      });
    }
    this.#options.onChange(placements);
  }
}

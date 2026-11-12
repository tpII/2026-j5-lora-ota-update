import { describe, expect, it } from "vite-plus/test";
import type { GraphNode } from "./connection-graph.ts";
import { hasVirtualMachineTrouble } from "./connection-graph.ts";
import {
  describeHearing,
  describeLastHeard,
  describeVirtualMachine,
} from "./connection-graph-descriptions.ts";

const HEARD: GraphNode = {
  id: "5C21",
  model: "V2",
  connected: false,
  source: "neighbor",
  activeVersion: 0,
  availableVersion: 0,
  vmFault: null,
  vmFailing: false,
  lastHeardHostTime: 1_000,
};

describe("describeVirtualMachine", () => {
  it("tells the last fault since the activation and a fault since the last HELLO", () => {
    expect(describeVirtualMachine(HEARD)).toBe("sin fallas");
    expect(describeVirtualMachine({ ...HEARD, vmFault: "division_by_zero", vmFailing: true })).toBe(
      "última falla: división por cero; falló desde su HELLO anterior",
    );
  });

  it("knows nothing of a node only listed by another one", () => {
    expect(describeVirtualMachine({ ...HEARD, source: "neighbor_list", vmFailing: null })).toBe(
      "—",
    );
  });
});

describe("hasVirtualMachineTrouble", () => {
  it("flags a fault since the activation or since the last HELLO", () => {
    expect(hasVirtualMachineTrouble(HEARD)).toBe(false);
    expect(hasVirtualMachineTrouble({ vmFault: "stack_overflow", vmFailing: false })).toBe(true);
    expect(hasVirtualMachineTrouble({ vmFault: null, vmFailing: true })).toBe(true);
    expect(hasVirtualMachineTrouble({ vmFault: null, vmFailing: null })).toBe(false);
  });
});

describe("describeHearing", () => {
  it("writes the RSSI and the SNR, or that there is no data", () => {
    expect(describeHearing({ rssi: -71.5, snr: 6.25, hostTime: 0 })).toBe("-71,5 dBm · 6,25 dB");
    expect(describeHearing(null)).toBe("sin datos");
  });
});

describe("describeLastHeard", () => {
  it("tells how long ago the panel heard of the node", () => {
    expect(describeLastHeard({ ...HEARD, connected: true }, 9_000)).toBe("consola abierta");
    expect(describeLastHeard(HEARD, 6_000)).toBe("hace 5 s");
    expect(describeLastHeard({ ...HEARD, lastHeardHostTime: null }, 6_000)).toBe("—");
  });
});

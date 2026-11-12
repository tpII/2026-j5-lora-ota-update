import { describe, expect, it } from "vite-plus/test";
import {
  RECEIVER_BOOT_HOST_TIME,
  SENDER_BOOT_HOST_TIME,
  UPDATE_ORIGIN_LOG,
  UPDATE_RECEIVER_LOG,
  readFixtureEvents,
} from "$lib/testing/console-fixtures.ts";
import {
  INITIAL_NODE_STATE,
  applyConsoleEvent,
  type NodeState,
} from "$lib/node-session/node-state.ts";
import { buildTransferActivity, describeImageReception } from "./transfer-activity.ts";

function replay(log: string, bootHostTime: number, count = Infinity): NodeState {
  return readFixtureEvents(log, bootHostTime)
    .slice(0, count)
    .reduce(
      (state, { event, hostTime }) => applyConsoleEvent(state, event, hostTime),
      INITIAL_NODE_STATE,
    );
}

const states = new Map([
  ["5C21", replay(UPDATE_ORIGIN_LOG, SENDER_BOOT_HOST_TIME)],
  ["3A7F", replay(UPDATE_RECEIVER_LOG, RECEIVER_BOOT_HOST_TIME)],
]);

describe("buildTransferActivity", () => {
  it("lists the transfer of both nodes, newest first", () => {
    const rows = buildTransferActivity(states, 100);
    expect(rows.map((row) => `${row.node} ${row.kind}: ${row.detail}`)).toEqual([
      "3A7F Imagen rechazada: 1762300900 desde 9B04: firma inválida",
      "3A7F Activación: 1762300800 (antes 0 (fábrica)): HELLO que la anuncia como activa (5C21)",
      "5C21 Activación: 1762300800 (antes 0 (fábrica)): orden del operador",
      "3A7F Ráfaga: 1762300800: 4 fragmentos de 32 bytes, 4 enviados; imagen completada por la radio",
      "3A7F Imagen disponible: 1762300800, completada por la radio desde 5C21: 4 fragmentos, 1 reporte, 137 ms",
      "5C21 Ráfaga: 1762300800: 1 fragmento de 32 bytes, 1 enviado; reporte de un receptor (3A7F)",
      "5C21 Reporte recibido: de 3A7F, versión 1762300800: falta 1 de 4 fragmentos (1)",
      "5C21 Ráfaga: 1762300800: 4 fragmentos de 32 bytes, 4 enviados; carga por la consola",
      "5C21 Imagen disponible: 1762300800, cargada por la consola (102 bytes)",
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it("keeps the newest rows only", () => {
    expect(buildTransferActivity(states, 2).map((row) => row.kind)).toEqual([
      "Imagen rechazada",
      "Activación",
    ]);
  });

  it("lists the last report a receiver sent while the reception is in progress", () => {
    const receiving = new Map([["3A7F", replay(UPDATE_RECEIVER_LOG, RECEIVER_BOOT_HOST_TIME, 10)]]);
    expect(buildTransferActivity(receiving, 100).map((row) => row.detail)).toEqual([
      "a 5C21, versión 1762300800, ronda 1: falta 1 de 4 fragmentos",
    ]);
  });
});

describe("describeImageReception", () => {
  it("says when the node receives nothing", () => {
    expect(describeImageReception(INITIAL_NODE_STATE)).toBe("ninguna");
  });

  it("counts the fragments held of the image in progress", () => {
    const receiving = replay(UPDATE_RECEIVER_LOG, RECEIVER_BOOT_HOST_TIME, 10);
    expect(describeImageReception(receiving)).toBe(
      "1762300800: 3 de 4 fragmentos de 32 bytes (75 %)",
    );
  });
});

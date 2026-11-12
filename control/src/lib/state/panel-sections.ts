import type { ExportedTest } from "$lib/measurements/measurement-export.ts";

/** The sections of the panel, in the order of their tabs, with the label of each tab. */
export const PANEL_SECTIONS = [
  { key: "network", label: "Red" },
  { key: "program", label: "Programa" },
  { key: "update", label: "Actualización" },
  { key: "measurements", label: "Mediciones" },
  { key: "events", label: "Flujo de eventos" },
] as const;

/** A section of the panel; the panel computes some snapshots only while theirs is visible. */
export type PanelSection = (typeof PANEL_SECTIONS)[number]["key"];

/**
 * The tests that the «Prueba» control of the measurement section offers, in the order of their
 * tabs, with the label of each tab. The first one is chosen when the panel opens. Each key is the
 * name of the test in its export folder.
 */
export const MEASUREMENT_SECTIONS = [
  { key: "power-sweep", label: "Barrido de potencia" },
  { key: "capacity-test", label: "Prueba de capacidad" },
  { key: "communication-test", label: "Prueba de comunicación" },
] as const satisfies readonly { readonly key: ExportedTest; readonly label: string }[];

export type MeasurementSectionTest = (typeof MEASUREMENT_SECTIONS)[number]["key"];

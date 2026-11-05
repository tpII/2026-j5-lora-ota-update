/**
 * The measurement sheet: where, how far apart, with which antennas and by whom a measurement was
 * taken. One sheet serves every export of the panel, so the operator fills it in once per field trip
 * and corrects it when something changes.
 */
import type { NodeIdentifier } from "$lib/console/console-event.ts";
import type { MeasurementDescription } from "$lib/measurements/measurement-export.ts";

export class MeasurementSheet {
  place = $state("");
  distance = $state<number | null>(null);
  antennas = $state("");
  operators = $state("");
  notes = $state("");
  /**
   * Nodes the operator left out of the power sweep and capacity test exports; every other node of
   * the journal is exported.
   */
  excludedNodes = $state<readonly NodeIdentifier[]>([]);

  readonly distanceValid = $derived(
    this.distance === null || (Number.isFinite(this.distance) && this.distance >= 0),
  );
  /** The problem that stops an export, in Spanish, or null when the sheet can be exported. */
  readonly problem = $derived(
    this.place.trim() === ""
      ? "Falta indicar el lugar en la ficha de la medición."
      : this.distanceValid
        ? null
        : "La distancia de la ficha de la medición no es válida.",
  );

  /** The sheet as the exports take it. */
  description(): Omit<MeasurementDescription, "test"> {
    return {
      place: this.place.trim(),
      distanceMeters:
        this.distance === null || !Number.isFinite(this.distance) ? null : this.distance,
      antennas: this.antennas.trim(),
      operators: this.operators.trim(),
      notes: this.notes.trim(),
    };
  }

  setNodeIncluded(id: NodeIdentifier, included: boolean): void {
    const others = this.excludedNodes.filter((excluded) => excluded !== id);
    this.excludedNodes = included ? others : [...others, id];
  }
}

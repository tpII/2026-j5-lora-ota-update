/**
 * A transmit power that the operator picked for one node in the power sweep form and has not
 * applied yet. The choice holds only while the node keeps reporting the power it had when the
 * operator picked: once the node reports another power, applied from here or elsewhere, the form
 * shows that one again.
 */
export interface PowerChoice {
  /** Connection of the node the power was picked for. */
  readonly key: string;
  readonly power: number;
  /** Power the node reported when the operator picked, or null when it had reported none. */
  readonly base: number | null;
}

export function choosePower(key: string, power: number, currentPower: number | null): PowerChoice {
  return { key, power, base: currentPower };
}

/** The power still waiting to be applied on the node of `key`, which reports `currentPower`. */
export function pendingPowerOf(
  choice: PowerChoice | null,
  key: string | null,
  currentPower: number | null,
): number | null {
  return choice !== null &&
    choice.key === key &&
    choice.base === currentPower &&
    choice.power !== currentPower
    ? choice.power
    : null;
}

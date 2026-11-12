/**
 * Keyboard navigation of a tab list, as the WAI-ARIA tabs pattern describes it: the arrows move to
 * the previous or the next tab and wrap around, Home goes to the first one and End to the last.
 * The tab that the keyboard reaches is selected at once.
 */

/** The tab that `key` moves to from the tab at `index` of `count`, or null for another key. */
export function adjacentTabIndex(key: string, index: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export function tabElementId(prefix: string, key: string): string {
  return `${prefix}${key}`;
}

export function panelElementId(prefix: string, key: string): string {
  return `${prefix}${key}`;
}

export function focusTab(prefix: string, key: string): void {
  document.getElementById(tabElementId(prefix, key))?.focus();
}

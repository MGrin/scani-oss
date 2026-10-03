/** Code-unit order: the tie-break by id every walk, report and loader shares. */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

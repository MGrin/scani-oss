/**
 * Select values for the CSV column mapping. A value is the header's position,
 * never its name, so a header that happens to be spelled like the "none"
 * choice, or a duplicate header, cannot collide with another option.
 */
export const NO_COLUMN = 'none';

export function columnChoices(headers: readonly string[]) {
  return headers.flatMap((label, index) =>
    label === '' ? [] : [{ value: `column-${index}`, label }]
  );
}

export function columnOption(column: string, headers: readonly string[]): string {
  const index = column === '' ? -1 : headers.indexOf(column);
  return index === -1 ? NO_COLUMN : `column-${index}`;
}

export function columnFromOption(option: string, headers: readonly string[]): string {
  const index = Number(option.replace(/^column-/, ''));
  return option === NO_COLUMN || !Number.isInteger(index) ? '' : (headers[index] ?? '');
}

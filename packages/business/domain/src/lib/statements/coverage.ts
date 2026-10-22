export interface StatementPeriod {
  from: string;
  to: string;
}

const monthOf = (day: string): string => day.slice(0, 7);

function monthsBetween(first: string, last: string): string[] {
  const months: string[] = [];
  let [year, month] = first.split('-').map(Number) as [number, number];
  for (;;) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    if (key > last) return months;
    months.push(key);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

/** Months, `YYYY-MM`, from the first statement through `through` that no statement touches. */
export function statementGaps(input: {
  statements: readonly StatementPeriod[];
  through: string;
}): string[] {
  if (input.statements.length === 0) return [];
  const covered = new Set(
    input.statements.flatMap((s) => monthsBetween(monthOf(s.from), monthOf(s.to)))
  );
  const first = input.statements.map((s) => monthOf(s.from)).sort()[0] as string;
  return monthsBetween(first, input.through).filter((month) => !covered.has(month));
}

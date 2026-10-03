import type { FeedWindow } from '../feed-batch';

export type WindowDeclaration =
  | { shape: 'balance-snapshot'; capturedAt: readonly Date[]; fetchedAt: Date }
  | { shape: 'statement-upload'; rowDates: readonly Date[]; uploadRef: string }
  | {
      shape: 'transaction-run';
      fetchedAt: Date;
      since?: Date;
      until?: Date;
      historyStartsAt?: Date;
      horizonMs?: number;
      retracted: boolean;
      firstEventAt?: Date;
    };

function extent(dates: readonly Date[], shape: WindowDeclaration['shape']): [Date, Date] {
  const first = dates[0];
  if (first === undefined) {
    throw new RangeError(`declareWindow: a ${shape} needs at least one date to bound its window`);
  }
  let min = first;
  let max = first;
  for (const date of dates) {
    if (date < min) min = date;
    if (date > max) max = date;
  }
  return [min, max];
}

/**
 * The window a fetch covers. `complete` claims the feed has said everything it
 * will ever say up to `to`, so only an unretracted run with no horizon can make
 * it, and an incomplete window must be bounded below (`from` is minus infinity
 * in the engine). Takes every instant as an argument; reads no clock.
 */
export function declareWindow(declaration: WindowDeclaration): FeedWindow {
  switch (declaration.shape) {
    case 'balance-snapshot': {
      const [from] = extent(declaration.capturedAt, declaration.shape);
      return { from, to: declaration.fetchedAt, complete: false };
    }
    case 'statement-upload': {
      const [from, to] = extent(declaration.rowDates, declaration.shape);
      return { from, to, complete: false, uploadRef: declaration.uploadRef };
    }
    case 'transaction-run': {
      const { fetchedAt, since, until, historyStartsAt, horizonMs, retracted, firstEventAt } =
        declaration;
      const complete = !retracted && horizonMs === undefined;
      const from =
        since ??
        historyStartsAt ??
        (horizonMs !== undefined
          ? new Date(fetchedAt.getTime() - horizonMs)
          : complete
            ? null
            : (firstEventAt ?? fetchedAt));
      return { from, to: until ?? fetchedAt, complete };
    }
  }
}

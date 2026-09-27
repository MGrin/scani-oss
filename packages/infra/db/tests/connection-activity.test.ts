import { expect, spyOn, test } from 'bun:test';
import { db, getActiveConnectionsCount } from '../src/connection';

test('reads postgres-js array results and distinguishes unavailable from zero', async () => {
  const execute = spyOn(db, 'execute');
  try {
    execute.mockResolvedValueOnce([{ count: 7 }] as never);
    expect(await getActiveConnectionsCount()).toBe(7);
    execute.mockResolvedValueOnce([{ count: 0 }] as never);
    expect(await getActiveConnectionsCount()).toBe(0);
    execute.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await getActiveConnectionsCount()).toBeNull();
  } finally {
    execute.mockRestore();
  }
});

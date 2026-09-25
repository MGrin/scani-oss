import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHUNK_MIN_AVAILABLE_MB,
  CHUNK_RSS_BUDGET_MB,
  memoryStopReason,
  readMemory,
} from '../../src/lib/memory-budget';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function meminfo(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'memory-budget-'));
  dirs.push(dir);
  const path = join(dir, 'meminfo');
  writeFileSync(path, text);
  return path;
}

describe('memoryStopReason (SC-1283)', () => {
  it('lets a chunk start inside both limits', () => {
    expect(memoryStopReason({ rssMb: 320, availableMb: 480 })).toBeNull();
  });

  it('stops on the worker RSS budget and names both numbers', () => {
    expect(memoryStopReason({ rssMb: CHUNK_RSS_BUDGET_MB + 1, availableMb: 480 })).toBe(
      `worker RSS ${CHUNK_RSS_BUDGET_MB + 1} MB is over the ${CHUNK_RSS_BUDGET_MB} MB budget`
    );
  });

  it('stops when the box has too little left for one more chunk', () => {
    expect(memoryStopReason({ rssMb: 320, availableMb: CHUNK_MIN_AVAILABLE_MB - 1 })).toBe(
      `${CHUNK_MIN_AVAILABLE_MB - 1} MB available is under the ${CHUNK_MIN_AVAILABLE_MB} MB one chunk needs`
    );
  });

  it('judges RSS alone where the box reading is unavailable', () => {
    expect(memoryStopReason({ rssMb: 320, availableMb: null })).toBeNull();
    expect(memoryStopReason({ rssMb: CHUNK_RSS_BUDGET_MB + 1, availableMb: null })).not.toBeNull();
  });
});

describe('readMemory (SC-1283)', () => {
  it('reads MemAvailable in MB and this process RSS', () => {
    const r = readMemory(meminfo('MemTotal: 1000000 kB\nMemAvailable:  409600 kB\n'));
    expect(r.availableMb).toBe(400);
    expect(r.rssMb).toBeGreaterThan(0);
  });

  it('reports an unreadable box as null, never as zero', () => {
    expect(readMemory(meminfo('MemTotal: 1000000 kB\n')).availableMb).toBeNull();
    expect(readMemory('/nonexistent/meminfo').availableMb).toBeNull();
  });
});

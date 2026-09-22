import { readFileSync } from 'node:fs';

// Thresholds for starting one more portfolio-history chunk (SC-1283), on the
// 1 GB worker VM that also hosts Redis. Measured 2026-09-21: the box read 0 MB
// available at worker RSS 850 MB, and the idle worker sits at ~300 MB with
// ~500 MB available. On the prod-shaped bench one 30-day chunk adds at most
// ~90 MB over the level it starts from once a full GC has run.
//
// The watchdog stops the whole VM under 160 MB available, i.e. around worker
// RSS 690 MB. A chunk that starts under 560 MB ends under ~650 even with the
// bench's figure padded by half again, so the job stops itself first and the
// watchdog is left for what this check cannot see.
export const CHUNK_RSS_BUDGET_MB = 560;
// Box-wide, for what worker RSS cannot see: Redis growth and other jobs. The
// watchdog floor plus one chunk with margin.
export const CHUNK_MIN_AVAILABLE_MB = 256;

export interface MemoryReading {
  rssMb: number;
  // null where /proc/meminfo is absent or unreadable — never read as 0.
  availableMb: number | null;
}

// Collects first: Bun grows the heap lazily, and without a full collection
// the reading is last chunk's garbage rather than what the next one starts on.
export function readMemory(meminfoPath = '/proc/meminfo'): MemoryReading {
  Bun.gc(true);
  const rssMb = Math.round(process.memoryUsage.rss() / 1_048_576);
  let availableMb: number | null = null;
  try {
    const kb = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync(meminfoPath, 'utf8'))?.[1];
    if (kb !== undefined) availableMb = Math.floor(Number(kb) / 1024);
  } catch {
    availableMb = null;
  }
  return { rssMb, availableMb };
}

export function memoryStopReason(reading: MemoryReading): string | null {
  if (reading.rssMb > CHUNK_RSS_BUDGET_MB) {
    return `worker RSS ${reading.rssMb} MB is over the ${CHUNK_RSS_BUDGET_MB} MB budget`;
  }
  if (reading.availableMb !== null && reading.availableMb < CHUNK_MIN_AVAILABLE_MB) {
    return `${reading.availableMb} MB available is under the ${CHUNK_MIN_AVAILABLE_MB} MB one chunk needs`;
  }
  return null;
}

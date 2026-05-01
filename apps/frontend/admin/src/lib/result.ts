export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function tryCatch<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Bounded-concurrency batch runner. Binance's history endpoints show real
// rate-limit pressure ("系統目前忙碌中") well before Node's event loop would
// — cap concurrency here rather than firing every item at once.
/**
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {{concurrency?: number, onResult?: (item: T, result: R|null, error: Error|null) => void}} [opts]
 * @returns {Promise<Array<{item: T, ok: boolean, result?: R, error?: string}>>}
 */
export async function runBatch(items, worker, opts = {}) {
  const { concurrency = 5, onResult } = opts;
  const results = new Array(items.length);
  let next = 0;

  async function runOne() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      try {
        const result = await worker(item, index);
        results[index] = { item, ok: true, result };
        onResult?.(item, result, null);
      } catch (error) {
        results[index] = { item, ok: false, error: error instanceof Error ? error.message : String(error) };
        onResult?.(item, null, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, runOne);
  await Promise.all(workers);
  return results;
}

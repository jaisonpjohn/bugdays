// Anonymous product analytics (GA4).
//
// Hard rule: never send anything a user typed, pasted, uploaded or connected to. No pasted text,
// file names, hostnames, endpoints, headers, queries or error messages — only tool ids, action
// names, export formats and coarse size buckets. `track` enforces this by dropping any value that
// is not a short slug, so a leak needs a deliberate change here rather than a careless call.
type Params = Record<string, string | number | undefined>;

/**
 * Slug-safe: lowercase letters, digits, `_` and `-` only, max 32 chars. Dots and colons are
 * excluded on purpose — they would let a hostname, endpoint or file name through.
 */
const SLUG = /^[a-z0-9_-]{1,32}$/;

/** Coarse input-size buckets. Exact sizes could help identify a specific document. */
export function sizeBucket(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1_000) return 'lt_1kb';
  if (bytes < 10_000) return 'lt_10kb';
  if (bytes < 100_000) return 'lt_100kb';
  if (bytes < 1_000_000) return 'lt_1mb';
  return 'gte_1mb';
}

/** Bucket a count (tables, threads, rows) the same way, so report cardinality stays low. */
export function countBucket(n: number): string {
  if (!Number.isFinite(n) || n < 0) return 'unknown';
  if (n <= 1) return '1';
  if (n <= 5) return '2_5';
  if (n <= 20) return '6_20';
  if (n <= 100) return '21_100';
  return 'gt_100';
}

export function track(event: string, params: Params = {}): void {
  try {
    const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
    if (typeof gtag !== 'function' || !SLUG.test(event)) return;
    const safe: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(params)) {
      if (!SLUG.test(key) || value === undefined) continue;
      if (typeof value === 'number') {
        if (Number.isFinite(value)) safe[key] = Math.round(value);
        continue;
      }
      const slug = String(value).toLowerCase();
      if (SLUG.test(slug)) safe[key] = slug;
    }
    gtag('event', event, safe);
  } catch {
    /* analytics must never break a tool */
  }
}

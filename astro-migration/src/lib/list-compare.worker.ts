import { compareLists } from './list-compare.ts';
import type { ListOptions } from './list-compare.ts';
self.onmessage = (event: MessageEvent<{ id: number; a: string; b: string; options: ListOptions }>) => {
  const { id, a, b, options } = event.data;
  try { self.postMessage({ id, report: compareLists(a, b, options) }); }
  catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : 'Could not compare these lists.' }); }
};

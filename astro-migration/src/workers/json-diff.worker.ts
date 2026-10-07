import { compareJson, JsonDiffError } from '../lib/json-diff.ts';
import { formatJson, JsonFormatError } from '../lib/json-formatter.ts';
self.onmessage = event => {
  let side: 'left' | 'right' = 'left';
  try {
    const { left, right, options, action } = event.data;
    if (action === 'format') {
      const a = formatJson(left).text; side = 'right'; const b = formatJson(right).text;
      self.postMessage({ ok: true, result: { left: a, right: b } });
    } else self.postMessage({ ok: true, result: compareJson(left, right, options) });
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : 'Local processing could not finish. Try a smaller document.', side: error instanceof JsonDiffError ? error.side : error instanceof JsonFormatError ? side : null, offset: error instanceof JsonDiffError || error instanceof JsonFormatError ? error.offset : null });
  }
};

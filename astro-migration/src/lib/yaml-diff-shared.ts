export const YAML_LIMITS = { bytes: 5 * 1024 ** 2, documents: 250, nodes: 100_000, depth: 100, changes: 5000, exportChars: 32 * 1024 ** 2 };
export interface YamlOptions { documents: 'position' | 'kubernetes'; arrays: 'position' | 'unordered' | 'key'; arrayKey: string; ignoredPaths: string; ignoreGenerated: boolean; }
export const defaultYamlOptions: YamlOptions = { documents: 'position', arrays: 'position', arrayKey: 'name', ignoredPaths: '', ignoreGenerated: false };
export interface YamlValue { document: number; pointer: string; offset: number; line: number; column: number; yaml: string; }
export interface YamlChange { type: 'added' | 'removed' | 'modified'; path: string; original?: YamlValue; modified?: YamlValue; }
export interface YamlResult { changes: YamlChange[]; documents: [number, number]; ignored: number; keyedLists: number; report: string; textReport: string; }
export class YamlDiffError extends Error {
  side: number | null; offset: number | null;
  constructor(message: string, side: number | null = null, offset: number | null = null) { super(message); this.side=side; this.offset=offset; }
}
export function validateYamlSize(text: string) {
  if (new TextEncoder().encode(text).length > YAML_LIMITS.bytes) throw new YamlDiffError('Each YAML input supports up to 5 MiB. Split the file into smaller parts.');
}

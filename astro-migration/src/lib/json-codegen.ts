export type CodeTarget = 'typescript' | 'zod' | 'pydantic';

type JsonNode =
  | { kind: 'unknown' | 'null' | 'string' | 'number' | 'boolean' }
  | { kind: 'array'; element: JsonNode }
  | { kind: 'object'; fields: Map<string, JsonField> }
  | { kind: 'union'; members: JsonNode[] };

interface JsonField {
  node: JsonNode;
  optional: boolean;
}

export interface GenerateCodeOptions {
  target: CodeTarget;
  rootName?: string;
}

const typeScriptReserved = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield']);
const pythonReserved = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);

function inferNode(value: unknown): JsonNode {
  if (value === null) return { kind: 'null' };
  if (Array.isArray(value)) return { kind: 'array', element: value.length ? value.map(inferNode).reduce(mergeNodes) : { kind: 'unknown' } };
  if (typeof value === 'string') return { kind: 'string' };
  if (typeof value === 'number') return { kind: 'number' };
  if (typeof value === 'boolean') return { kind: 'boolean' };
  if (typeof value === 'object') {
    const fields = new Map<string, JsonField>();
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) fields.set(key, { node: inferNode(child), optional: false });
    return { kind: 'object', fields };
  }
  return { kind: 'unknown' };
}

function nodeSignature(node: JsonNode): string {
  if (node.kind === 'array') return `array(${nodeSignature(node.element)})`;
  if (node.kind === 'object') return `object(${[...node.fields.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, field]) => `${key}:${field.optional ? '?' : '!'}${nodeSignature(field.node)}`).join(',')})`;
  if (node.kind === 'union') return `union(${node.members.map(nodeSignature).sort().join('|')})`;
  return node.kind;
}

function mergeNodes(left: JsonNode, right: JsonNode): JsonNode {
  if (left.kind === 'unknown') return right;
  if (right.kind === 'unknown') return left;
  if (left.kind === right.kind) {
    if (left.kind === 'array' && right.kind === 'array') return { kind: 'array', element: mergeNodes(left.element, right.element) };
    if (left.kind === 'object' && right.kind === 'object') {
      const fields = new Map<string, JsonField>();
      const keys = new Set([...left.fields.keys(), ...right.fields.keys()]);
      for (const key of keys) {
        const a = left.fields.get(key);
        const b = right.fields.get(key);
        if (a && b) fields.set(key, { node: mergeNodes(a.node, b.node), optional: a.optional || b.optional });
        else if (a) fields.set(key, { node: a.node, optional: true });
        else if (b) fields.set(key, { node: b.node, optional: true });
      }
      return { kind: 'object', fields };
    }
    if (left.kind !== 'union') return left;
  }
  const members = [...(left.kind === 'union' ? left.members : [left]), ...(right.kind === 'union' ? right.members : [right])];
  const unique = new Map<string, JsonNode>();
  for (const member of members) unique.set(nodeSignature(member), member);
  return { kind: 'union', members: [...unique.values()] };
}

function pascalCase(value: string): string {
  const result = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => `${part[0].toUpperCase()}${part.slice(1)}`).join('');
  return /^[A-Za-z]/.test(result) ? result || 'Root' : `Value${result || 'Root'}`;
}

function singular(value: string): string {
  if (/ies$/i.test(value)) return `${value.slice(0, -3)}y`;
  if (/ses$/i.test(value)) return value.slice(0, -2);
  if (/s$/i.test(value) && value.length > 1) return value.slice(0, -1);
  return value;
}

function typeName(parent: string, key: string, arrayItem = false) {
  return pascalCase(`${parent} ${arrayItem ? singular(key) : key}`);
}

function arrayItemName(suggested: string) {
  return pascalCase(singular(suggested));
}

function isTypeScriptIdentifier(value: string) {
  return /^[A-Za-z_$][\w$]*$/.test(value) && !typeScriptReserved.has(value);
}

function quoteTypeScriptKey(value: string) {
  return isTypeScriptIdentifier(value) ? value : JSON.stringify(value);
}

function pythonName(value: string) {
  const snake = value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  const candidate = /^[A-Za-z_]/.test(snake) ? snake || 'value' : `value_${snake || 'field'}`;
  return pythonReserved.has(candidate) ? `${candidate}_` : candidate;
}

function nameAllocator() {
  const counts = new Map<string, number>();
  return (suggested: string) => {
    const base = pascalCase(suggested);
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    return count ? `${base}${count + 1}` : base;
  };
}

function generateTypeScript(root: JsonNode, rootName: string) {
  const declareName = nameAllocator();
  const declarations: string[] = [];
  const render = (node: JsonNode, suggested: string): string => {
    switch (node.kind) {
      case 'unknown': return 'unknown';
      case 'null': return 'null';
      case 'string': return 'string';
      case 'number': return 'number';
      case 'boolean': return 'boolean';
      case 'array': return `Array<${render(node.element, arrayItemName(suggested))}>`;
      case 'union': return node.members.map(member => render(member, suggested)).join(' | ');
      case 'object': {
        const name = declareName(suggested);
        const fields = [...node.fields.entries()].map(([key, field]) => `  ${quoteTypeScriptKey(key)}${field.optional ? '?' : ''}: ${render(field.node, typeName(name, key))};`);
        declarations.push(`export interface ${name} {\n${fields.join('\n')}\n}`);
        return name;
      }
    }
  };
  const type = render(root, root.kind === 'object' ? rootName : `${rootName}Item`);
  return root.kind === 'object' ? declarations.join('\n\n') : `export type ${pascalCase(rootName)} = ${type};\n\n${declarations.join('\n\n')}`.trim();
}

function generateZod(root: JsonNode, rootName: string) {
  const render = (node: JsonNode): string => {
    switch (node.kind) {
      case 'unknown': return 'z.unknown()';
      case 'null': return 'z.null()';
      case 'string': return 'z.string()';
      case 'number': return 'z.number()';
      case 'boolean': return 'z.boolean()';
      case 'array': return `z.array(${render(node.element)})`;
      case 'object': return `z.object({\n${[...node.fields.entries()].map(([key, field]) => `  ${JSON.stringify(key)}: ${render(field.node)}${field.optional ? '.optional()' : ''},`).join('\n')}\n})`;
      case 'union': {
        const nullable = node.members.filter(member => member.kind !== 'null');
        if (nullable.length === 1 && nullable.length !== node.members.length) return `${render(nullable[0])}.nullable()`;
        return `z.union([${node.members.map(render).join(', ')}])`;
      }
    }
  };
  const name = pascalCase(rootName);
  return `import { z } from 'zod';\n\nexport const ${name}Schema = ${render(root)};\n\nexport type ${name} = z.infer<typeof ${name}Schema>;`;
}

function generatePydantic(root: JsonNode, rootName: string) {
  const declareName = nameAllocator();
  const declarations: string[] = [];
  let usesAny = false;
  let usesField = false;
  const render = (node: JsonNode, suggested: string): string => {
    switch (node.kind) {
      case 'unknown': usesAny = true; return 'Any';
      case 'null': return 'None';
      case 'string': return 'str';
      case 'number': return 'float';
      case 'boolean': return 'bool';
      case 'array': return `list[${render(node.element, arrayItemName(suggested))}]`;
      case 'union': return node.members.map(member => render(member, suggested)).join(' | ');
      case 'object': {
        const name = declareName(suggested);
        const fields = [...node.fields.entries()].map(([key, field]) => {
          const property = pythonName(key);
          const needsAlias = property !== key;
          if (needsAlias) usesField = true;
          const type = render(field.node, typeName(name, key));
          const optional = field.optional;
          const annotation = optional && !type.includes('None') ? `${type} | None` : type;
          const assignment = needsAlias
            ? ` = Field(${optional ? 'default=None, ' : ''}alias=${JSON.stringify(key)})`
            : optional ? ' = None' : '';
          return `    ${property}: ${annotation}${assignment}`;
        });
        const aliases = [...node.fields.keys()].some(key => pythonName(key) !== key);
        if (aliases) fields.push("\n    model_config = {'populate_by_name': True}");
        declarations.push(`class ${name}(BaseModel):\n${fields.length ? fields.join('\n') : '    pass'}`);
        return name;
      }
    }
  };
  const rootType = render(root, root.kind === 'object' ? rootName : `${rootName}Item`);
  const imports = [`from pydantic import BaseModel${usesField ? ', Field' : ''}`];
  if (usesAny) imports.unshift('from typing import Any');
  const prefix = root.kind === 'object' ? '' : `\n\n${pascalCase(rootName)} = ${rootType}`;
  return `${imports.join('\n')}\n\n${declarations.join('\n\n')}${prefix}`.trim();
}

export function generateJsonCode(value: unknown, options: GenerateCodeOptions): string {
  const root = inferNode(value);
  const rootName = pascalCase(options.rootName?.trim() || 'Root');
  if (options.target === 'typescript') return generateTypeScript(root, rootName);
  if (options.target === 'zod') return generateZod(root, rootName);
  return generatePydantic(root, rootName);
}

export function parseAndGenerateJsonCode(input: string, options: GenerateCodeOptions): string {
  return generateJsonCode(JSON.parse(input), options);
}

import { dirname, join, resolve } from 'node:path';

/**
 * Reads a React Router table as source and finds, for every `element={<X`, the
 * body of the component `X` — so a test can ask what each registered route
 * renders without rendering it. This suite has no DOM, and `document.title` is
 * written from an effect, which `renderToStaticMarkup` never runs (SC-996).
 *
 * Deliberately a text reader, like `route-split.test.ts`: the tables here are
 * plain JSX, and a component is found the three ways they reference one — a
 * named import, a `lazyRoute(..., () => import(...).then((m) => m.X))`, or a
 * function in the table's own file.
 */

export interface RouteComponent {
  name: string;
  file: string;
  body: string;
}

const ELEMENT = /element=\{\s*<([A-Z]\w*)/g;

export function routeElementNames(source: string): string[] {
  return [...new Set([...source.matchAll(ELEMENT)].map((match) => match[1] as string))];
}

async function firstExisting(base: string): Promise<string | null> {
  for (const candidate of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx')]) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return null;
}

function specifierFor(source: string, name: string): string | null {
  const lazy = new RegExp(
    `const ${name}\\s*=\\s*lazyRoute\\([\\s\\S]*?import\\(\\s*['"]([^'"]+)['"]\\s*\\)`
  ).exec(source);
  if (lazy) return lazy[1] as string;
  for (const match of source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm)) {
    const names = (match[1] as string).split(',').map((part) => part.trim().split(/\s+as\s+/)[0]);
    if (names.includes(name)) return match[2] as string;
  }
  return null;
}

/** From `from`, the index just past the bracket that closes the one at `from`. */
function pastBalanced(source: string, from: number, open: string, close: string): number | null {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) return i + 1;
  }
  return null;
}

/**
 * The `{ … }` of `function name(…)`, by bracket depth. The parameter list is
 * skipped first, because a destructured prop (`({ location }: …)`) opens a
 * brace before the body does.
 */
export function functionBody(source: string, name: string): string | null {
  const start = new RegExp(`(?:^|\\n)(?:export\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!start) return null;
  const paramsEnd = pastBalanced(source, start.index + start[0].length - 1, '(', ')');
  if (paramsEnd === null) return null;
  const bodyStart = source.indexOf('{', paramsEnd);
  const bodyEnd = bodyStart === -1 ? null : pastBalanced(source, bodyStart, '{', '}');
  return bodyEnd === null ? null : source.slice(bodyStart + 1, bodyEnd - 1);
}

/**
 * @param srcRoot what `@/` resolves to in this app.
 * @returns every component a route in `tableFile` renders, or throws naming
 *   the one it could not find — an unresolved element is a broken reader, and
 *   silently skipping it would make the check pass over exactly the route it
 *   could not see.
 */
export async function routeComponents(
  tableFile: string,
  srcRoot: string
): Promise<RouteComponent[]> {
  const table = await Bun.file(tableFile).text();
  const out: RouteComponent[] = [];
  for (const name of routeElementNames(table)) {
    const specifier = specifierFor(table, name);
    let file = tableFile;
    if (specifier !== null) {
      if (!specifier.startsWith('.') && !specifier.startsWith('@/')) {
        out.push({ name, file: specifier, body: '' });
        continue;
      }
      const base = specifier.startsWith('@/')
        ? join(srcRoot, specifier.slice(2))
        : resolve(dirname(tableFile), specifier);
      const found = await firstExisting(base);
      if (!found) throw new Error(`${name}: cannot resolve '${specifier}' from ${tableFile}`);
      file = found;
    }
    const body = functionBody(await Bun.file(file).text(), name);
    if (body === null) throw new Error(`${name}: no \`function ${name}\` in ${file}`);
    out.push({ name, file, body });
  }
  return out;
}

export const TITLE_CALL = 'useDocumentTitle(';

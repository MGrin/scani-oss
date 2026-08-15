/**
 * A deliberately small CSS reader for the token stylesheets.
 *
 * It exists so the contrast tests assert against the file that actually ships
 * rather than a duplicated table of values — a duplicated table is what lets a
 * token drift out of compliance while its test stays green.
 */

export type CssBlock = {
  /** Selector text, whitespace-collapsed. */
  selector: string;
  /** At-rule preludes enclosing this block, outermost first. */
  atRules: string[];
  /** Raw declarations, `--name` → value, in source order. */
  declarations: Record<string, string>;
};

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseDeclarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chunk of body.split(';')) {
    const idx = chunk.indexOf(':');
    if (idx === -1) continue;
    const name = chunk.slice(0, idx).trim();
    if (!name.startsWith('--')) continue;
    out[name] = chunk.slice(idx + 1).trim();
  }
  return out;
}

/** Returns every leaf block (a `{}` containing no nested block) with its at-rule chain. */
export function parseCss(css: string): CssBlock[] {
  const src = stripComments(css);
  const blocks: CssBlock[] = [];
  const stack: string[] = [];
  let prelude = '';
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') {
      const head = prelude.trim().replace(/\s+/g, ' ');
      const close = matchBrace(src, i);
      const body = src.slice(i + 1, close);
      if (body.includes('{')) {
        stack.push(head);
        prelude = '';
        i += 1;
        continue;
      }
      blocks.push({
        selector: head,
        atRules: [...stack],
        declarations: parseDeclarations(body),
      });
      prelude = '';
      i = close + 1;
      continue;
    }
    if (ch === '}') {
      stack.pop();
      prelude = '';
      i += 1;
      continue;
    }
    prelude += ch;
    i += 1;
  }
  return blocks;
}

function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced braces in stylesheet');
}

/**
 * Resolves `var(--x)` chains within a single flat declaration set. Custom
 * properties are substituted at computed-value time against the element's own
 * final values, which is exactly what a flat map models.
 */
export function resolveVars(declarations: Record<string, string>): Record<string, string> {
  const resolve = (name: string, seen: Set<string>): string => {
    const raw = declarations[name];
    if (raw === undefined) throw new Error(`undefined custom property: ${name}`);
    if (seen.has(name)) throw new Error(`circular custom property: ${name}`);
    const match = raw.match(/^var\((--[\w-]+)\)$/);
    if (!match) return raw;
    return resolve(match[1] as string, new Set([...seen, name]));
  };

  const out: Record<string, string> = {};
  for (const name of Object.keys(declarations)) out[name] = resolve(name, new Set());
  return out;
}

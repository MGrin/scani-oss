import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { usePortalContainer } from '../../src/lib/portal-container';

/**
 * A portalled overlay that mounts on `document.body` escapes any scoped token
 * layer above it — v3 hangs its tokens off `[data-ui="v3"]`, so an escaped
 * overlay silently renders against v2's. Nothing else catches that: it
 * type-checks, it renders, and it looks like a coherent UI from the wrong
 * design system.
 *
 * So the invariant is checked in the source: every JSX `*Portal` in the
 * primitive set forwards a `container`, which `usePortalContainer` resolves
 * from the nearest `PortalContainerProvider`.
 */
const UI_DIR = join(import.meta.dir, '../../src/ui');

/** Opening tags of anything whose name ends in `Portal`, with their attrs. */
const PORTAL_TAG = /<([A-Za-z][\w.]*Portal)\b([^>]*)>/g;

const sources = readdirSync(UI_DIR)
  .filter((file) => file.endsWith('.tsx'))
  .map((file) => ({ file, code: Bun.file(join(UI_DIR, file)).text() }));

const portalled: { file: string; tags: { name: string; attrs: string }[] }[] = [];
for (const { file, code } of sources) {
  const tags = [...(await code).matchAll(PORTAL_TAG)].map((m) => ({
    name: m[1] as string,
    attrs: m[2] as string,
  }));
  if (tags.length > 0) portalled.push({ file, tags });
}

describe('portal container', () => {
  test('the portalling primitives are the ones we know about', () => {
    // A new entry here is a new way for an overlay to leave the v3 token
    // scope. Give it a `container` prop and add it to this list.
    expect(portalled.map((p) => p.file).sort()).toEqual([
      'bottom-drawer.tsx',
      'dialog.tsx',
      'popover.tsx',
      'select.tsx',
      'sheet.tsx',
      'tooltip.tsx',
    ]);
  });

  for (const { file, tags } of portalled) {
    test(`${file} forwards a container to every Portal`, () => {
      for (const tag of tags) {
        expect(`${file}: <${tag.name}${tag.attrs}>`).toContain('container=');
      }
    });
  }

  test('with no provider the container is Radix’s own default, i.e. document.body', () => {
    // What makes the `:root` token variant need no provider at all: an app that
    // put the tokens on the document has `document.body` inside the scope
    // already, and the unset context resolves to exactly the pre-V3-22
    // behaviour. Only the scoped mode has to wrap its tree.
    let resolved: unknown = 'not rendered';
    function Probe() {
      resolved = usePortalContainer();
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    expect(resolved).toBeUndefined();
  });
});

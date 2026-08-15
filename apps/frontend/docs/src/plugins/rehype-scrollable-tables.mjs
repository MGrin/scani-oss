// @ts-check

// Wraps every Markdown table in a labelled, focusable scroll region.
//
// Starlight styles tables as `display: block; overflow: auto`, which makes the
// `<table>` its own scroll container. That works — the table does scroll — but
// on a phone nothing says so. Measured on `/reference/provider-matrix/` at
// 390x844: `clientWidth` 358 against `scrollWidth` 746, so 388px of columns sit
// off-screen; the page itself does not scroll horizontally, iOS hides overlay
// scrollbars at rest, and the table carries no shadow, caption, border or
// label. Two of four columns are reachable and there is no pixel on screen
// saying otherwise. Because row height is set by the tallest cell and the
// tallest cell is the invisible `Notes` prose, each row is 101px tall while
// showing two short values — the same visual signature as a rendering bug, so
// the page reads as broken rather than as scrollable (SC-102).
//
// The scrolling is not the defect and is not touched. What this adds is the
// affordance: the wrapper is the scroll container so it can take `tabindex`
// and `role="region"` without overriding the table's own semantics (a `role`
// on the `<table>` itself would cost screen-reader table navigation), and
// `custom.css` paints an edge fade on it. Column geometry is preserved — the
// table goes back to `display: table` with `min-width: 100%`, so it still
// overflows at its min-content width exactly as it does today.
//
// `scripts/check-tables.ts` fails the build if a built page ever contains a
// `<table>` that is not inside one of these.

/** @typedef {{ type: string, tagName?: string, properties?: Record<string, unknown>, children?: Node[], value?: string }} Node */

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * @param {Node} node
 * @returns {string}
 */
function textOf(node) {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/**
 * `<table>` → `<div class="table-scroll">` wrapping a hint and a labelled
 * viewport. The injected script reveals the hint only when the table actually
 * overflows.
 *
 * The hint goes ABOVE the table, not below it. These tables are 900px tall on
 * a phone — the `Notes` column sets the row height whether or not it is on
 * screen — so a caption underneath is several screens past the point where the
 * reader has already decided the page is broken.
 *
 * @param {Node} table
 * @param {string} label
 * @returns {Node}
 */
function wrap(table, label) {
  return {
    type: 'element',
    tagName: 'div',
    properties: { className: ['table-scroll'] },
    children: [
      {
        type: 'element',
        tagName: 'p',
        properties: { className: ['table-scroll-hint'], hidden: true, 'aria-hidden': 'true' },
        children: [{ type: 'text', value: 'Scroll sideways for more columns' }],
      },
      {
        type: 'element',
        tagName: 'div',
        properties: {
          className: ['table-scroll-viewport'],
          tabIndex: 0,
          role: 'region',
          'aria-label': label,
        },
        children: [table],
      },
    ],
  };
}

/**
 * The nearest preceding heading names the region, so a page with eight tables
 * does not present eight identically-labelled ones to a screen reader.
 *
 * @param {Node} parent
 */
function transformChildren(parent) {
  const children = parent.children ?? [];
  let heading = '';

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.type !== 'element') continue;

    if (child.tagName && HEADINGS.has(child.tagName)) {
      heading = textOf(child).trim();
      continue;
    }

    if (child.tagName === 'table') {
      children[index] = wrap(child, heading ? `${heading} table` : 'Table');
      continue;
    }

    transformChildren(child);
  }
}

export function rehypeScrollableTables() {
  return (/** @type {Node} */ tree) => {
    transformChildren(tree);
  };
}

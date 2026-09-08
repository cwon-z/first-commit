/* ============================================================================
 * first-commit — lesson content renderer
 * ----------------------------------------------------------------------------
 * Renders the structured content blocks from /content/course.json into DOM.
 * Content is DATA, never trusted HTML: everything is escaped, then a tiny
 * whitelist of inline markup (`code`, **bold**, *em*) is applied.
 * ========================================================================== */

/** Block keys `renderBlocks` understands. The content test validates against
 *  this list so a typo'd block in course.json fails CI instead of vanishing. */
export const BLOCK_KINDS = ['h', 'p', 'analogy', 'tip', 'warn', 'code', 'list', 'graph'];

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Escape, then apply minimal inline markdown: `code`, **strong**, *em*. */
export function inlineMd(s) {
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
  return out;
}

/**
 * @param {HTMLElement} container
 * @param {Array<object>} blocks
 * @param {{ graphFromOps?: (ops:Array)=>HTMLElement }} helpers
 */
export function renderBlocks(container, blocks = [], helpers = {}) {
  for (const block of blocks) {
    if (block.h != null) {
      const h = document.createElement('h3');
      h.className = 'lesson-h';
      h.innerHTML = inlineMd(block.h);
      container.appendChild(h);
    } else if (block.p != null) {
      const p = document.createElement('p');
      p.className = 'lesson-p';
      p.innerHTML = inlineMd(block.p);
      container.appendChild(p);
    } else if (block.analogy != null) {
      const d = document.createElement('div');
      d.className = 'lesson-callout lesson-analogy';
      d.innerHTML = `<span class="callout-tag">Think of it like this</span><p>${inlineMd(block.analogy)}</p>`;
      container.appendChild(d);
    } else if (block.tip != null) {
      const d = document.createElement('div');
      d.className = 'lesson-callout lesson-tip';
      d.innerHTML = `<span class="callout-tag">Tip</span><p>${inlineMd(block.tip)}</p>`;
      container.appendChild(d);
    } else if (block.warn != null) {
      const d = document.createElement('div');
      d.className = 'lesson-callout lesson-warn';
      d.innerHTML = `<span class="callout-tag">Care</span><p>${inlineMd(block.warn)}</p>`;
      container.appendChild(d);
    } else if (block.code != null) {
      const pre = document.createElement('pre');
      pre.className = 'lesson-code';
      const code = document.createElement('code');
      code.textContent = block.code;
      pre.appendChild(code);
      container.appendChild(pre);
    } else if (block.list != null) {
      const ul = document.createElement('ul');
      ul.className = 'lesson-list';
      for (const item of block.list) {
        const li = document.createElement('li');
        li.innerHTML = inlineMd(item);
        ul.appendChild(li);
      }
      container.appendChild(ul);
    } else if (block.graph != null) {
      if (!helpers.graphFromOps) continue;
      const fig = document.createElement('figure');
      fig.className = 'lesson-figure';
      const graphEl = helpers.graphFromOps(block.graph.ops || []);
      fig.appendChild(graphEl);
      if (block.graph.caption) {
        const cap = document.createElement('figcaption');
        cap.innerHTML = inlineMd(block.graph.caption);
        fig.appendChild(cap);
      }
      container.appendChild(fig);
    } else {
      // Otherwise an authoring typo (`{"para": …}`) would silently render
      // nothing and nobody would ever notice.
      console.warn('renderBlocks: unrecognised content block', block);
    }
  }
}

export default renderBlocks;

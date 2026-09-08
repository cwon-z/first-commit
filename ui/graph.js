/* ============================================================================
 * first-commit — commit graph renderer
 * ----------------------------------------------------------------------------
 * Renders an engine.getGraph() snapshot as SVG: commits as circles laid out
 * left→right by creation order, one horizontal lane per branch, curved edges
 * to parents, and ref labels (branches / origin/* / HEAD) on stems above the
 * tips. This is the course's core teaching visual — it redraws after every
 * command, so the geometry is deliberately stable: a commit never moves once
 * it is drawn, which is what makes "one more node appeared" readable.
 *
 * Everything visual is carried by CSS classes (see css/tokens.css) so the
 * landing page can hand-author a static twin with the same look.
 * ========================================================================== */

const SVG_NS = 'http://www.w3.org/2000/svg';

const X_STEP = 78;       // horizontal distance between consecutive commits
const LANE_STEP = 52;    // vertical distance between branch lanes
const NODE_R = 7;
const HEAD_RING_R = 12;
const PILL_H = 20;
const PILL_STEP = 26;    // vertical pitch when several refs stack on one commit
const LANES = 3;         // lane colour classes available in CSS: .lane-0 … .lane-2
const CHAR_W = 6.5;      // JetBrains Mono at 10px, plus a little air

/** Width of a ref pill for `label`, matching the CSS type size. */
const refWidth = (label) => label.length * CHAR_W + 22;

function el(name, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.appendChild(c);
  return node;
}

function text(str, attrs = {}) {
  const t = el('text', attrs);
  t.textContent = str;
  return t;
}

function size(svg, width, height, empty = false) {
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  return { width, height, empty };
}

/** Before `git init`, and after it but before the first commit, read alike but
 *  are genuinely different states — so they say different things. */
function renderEmpty(svg, title, sub) {
  const W = 320;
  const H = 140;
  svg.appendChild(el('circle', { cx: W / 2, cy: 50, r: 10, class: 'cg-empty-mark' }));
  svg.appendChild(text(title, { x: W / 2, y: 84, class: 'cg-empty-title', 'text-anchor': 'middle' }));
  svg.appendChild(text(sub, { x: W / 2, y: 104, class: 'cg-empty-sub', 'text-anchor': 'middle' }));
  return size(svg, W, H, true);
}

/** An unresolved merge is a state the learner has to act on, so it is stated
 *  on the graph itself rather than only in the terminal scrollback. */
function renderMergingBanner(svg, width, y) {
  const g = el('g', { class: 'cg-merging' });
  g.appendChild(el('rect', { x: 12, y, width: width - 24, height: 32, rx: 8 }));
  g.appendChild(text('MERGING', { x: 24, y: y + 20, class: 'cg-merging-tag' }));
  g.appendChild(text('Conflict unresolved. Fix the file, then add and commit.', {
    x: 84, y: y + 20, class: 'cg-merging-text',
  }));
  svg.appendChild(g);
}

/**
 * @param {SVGElement} svg  target <svg>
 * @param {object} graph    engine.getGraph() result
 * @returns {{width:number,height:number}} rendered size (for auto-scroll)
 */
export function renderGraph(svg, graph) {
  svg.innerHTML = '';
  svg.classList.add('commit-graph');

  if (!graph || !graph.initialized) {
    return renderEmpty(svg, 'No repository', 'run  git init  to begin');
  }
  if (!graph.commits.length) {
    return renderEmpty(svg, 'Empty repository', 'your first commit appears here');
  }

  /* ---- ref labels, collected first: they set the left and right margins --- */
  const refs = new Map();
  const addRef = (id, label, kind) => {
    if (!id) return;
    if (!refs.has(id)) refs.set(id, []);
    refs.get(id).push({ label, kind });
  };
  for (const b of graph.branches) {
    addRef(b.tip, b.current ? 'HEAD → ' + b.name : b.name, b.current ? 'head' : 'branch');
  }
  for (const r of graph.remoteBranches) addRef(r.tip, r.name, 'remote');
  if (graph.head.detached && graph.head.id) addRef(graph.head.id, 'HEAD detached', 'detached');

  let widest = 56;
  for (const list of refs.values()) {
    for (const r of list) widest = Math.max(widest, refWidth(r.label));
  }
  const xStart = Math.round(widest / 2) + 14;

  /* ---- lane assignment: one lane per branch hint, main pinned to lane 0 --- */
  const laneMap = new Map([['main', 0]]);
  let nextLane = 1;
  const laneFor = (hint) => {
    const key = hint || '(detached)';
    if (!laneMap.has(key)) laneMap.set(key, nextLane++);
    return laneMap.get(key);
  };

  const pos = new Map(); // id -> {x, y, lane}
  graph.commits.forEach((c, i) => {
    pos.set(c.id, { x: xStart + i * X_STEP, y: 0, lane: laneFor(c.branchHint) });
  });
  const usedLanes = Math.max(1, ...[...pos.values()].map((p) => p.lane + 1));

  // Refs on commits the engine no longer reports are dropped, not drawn at 0,0.
  for (const id of [...refs.keys()]) if (!pos.has(id)) refs.delete(id);

  const maxStack = Math.max(1, ...[...refs.values()].map((r) => r.length));
  const topPad = 22 + maxStack * PILL_STEP;
  let height = topPad + (usedLanes - 1) * LANE_STEP + 34;
  const width = Math.max(
    graph.merging ? 420 : 0,
    xStart + (graph.commits.length - 1) * X_STEP + Math.round(widest / 2) + 16
  );
  for (const p of pos.values()) p.y = topPad + p.lane * LANE_STEP;

  const mergingY = height;
  if (graph.merging) height += 44;
  size(svg, width, height);

  /* ---- edges (drawn first, under everything) ---- */
  const edges = el('g', { class: 'graph-edges' });
  for (const c of graph.commits) {
    const child = pos.get(c.id);
    c.parents.forEach((pid, idx) => {
      const parent = pos.get(pid);
      if (!parent) return;
      // A merge's second parent keeps the colour of the lane it came from, so
      // the eye can follow the branch that was absorbed.
      const lane = (idx === 0 ? child.lane : parent.lane) % LANES;
      const d = parent.y === child.y
        ? `M ${parent.x} ${parent.y} L ${child.x} ${child.y}`
        : `M ${parent.x} ${parent.y} C ${(parent.x + child.x) / 2} ${parent.y}, ` +
          `${(parent.x + child.x) / 2} ${child.y}, ${child.x} ${child.y}`;
      edges.appendChild(el('path', { d, class: `cg-edge lane-${lane}` }));
    });
  }
  svg.appendChild(edges);

  /* ---- stems: the hairline joining a commit to its stack of ref pills ---- */
  const stems = el('g', { class: 'graph-stems' });
  for (const [id, list] of refs) {
    const p = pos.get(id);
    const topY = p.y - 24 - (list.length - 1) * PILL_STEP;
    stems.appendChild(el('line', {
      x1: p.x, y1: topY, x2: p.x, y2: p.y - NODE_R - 2, class: 'cg-stem',
    }));
  }
  svg.appendChild(stems);

  /* ---- nodes ---- */
  const nodes = el('g', { class: 'graph-nodes' });
  const headId = graph.head.id;
  for (const c of graph.commits) {
    const p = pos.get(c.id);
    const isHead = c.id === headId;
    const g = el('g', { class: 'graph-node', transform: `translate(${p.x},${p.y})` });
    if (isHead) g.appendChild(el('circle', { r: HEAD_RING_R, class: 'node-head-ring' }));
    const circle = el('circle', {
      r: NODE_R,
      class: 'cg-node' + (isHead ? ' is-head' : '') + (c.parents.length > 1 ? ' is-merge' : ''),
    });
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `${c.short}  ${c.message}`;
    circle.appendChild(title);
    g.appendChild(circle);
    g.appendChild(text(c.short, {
      y: 22, class: 'cg-sha' + (isHead ? ' is-head' : ''), 'text-anchor': 'middle',
    }));
    nodes.appendChild(g);
  }
  svg.appendChild(nodes);

  /* ---- ref pills, stacked upwards from the newest ---- */
  const pills = el('g', { class: 'graph-pills' });
  for (const [id, list] of refs) {
    const p = pos.get(id);
    list.forEach((ref, i) => {
      const w = refWidth(ref.label);
      const y = p.y - 24 - i * PILL_STEP;
      const g = el('g', { class: `cg-pill kind-${ref.kind}`, transform: `translate(${p.x},${y})` });
      g.appendChild(el('rect', { x: -w / 2, y: -PILL_H, width: w, height: PILL_H, rx: PILL_H / 2 }));
      g.appendChild(text(ref.label, { y: -6, 'text-anchor': 'middle' }));
      pills.appendChild(g);
    });
  }
  svg.appendChild(pills);

  if (graph.merging) renderMergingBanner(svg, width, mergingY);

  return { width, height };
}

export default renderGraph;

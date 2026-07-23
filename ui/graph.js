/* ============================================================================
 * first-commit — commit graph renderer
 * ----------------------------------------------------------------------------
 * Renders an engine.getGraph() snapshot as SVG: commits as circles laid out
 * left→right by creation order, one horizontal lane per branch, curved edges
 * to parents, and ref labels (branches / origin/* / HEAD) above the tips.
 * This is the course's core teaching visual — it redraws after every command.
 * ========================================================================== */

const SVG_NS = 'http://www.w3.org/2000/svg';
const X_STEP = 72;
const X_START = 44;
const LANE_STEP = 46;
const NODE_R = 9;
const LANES = 6; // lane color classes available in CSS: .lane-0 … .lane-5

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

/**
 * @param {SVGElement} svg  target <svg>
 * @param {object} graph    engine.getGraph() result
 * @returns {{width:number,height:number}} rendered size (for auto-scroll)
 */
export function renderGraph(svg, graph) {
  svg.innerHTML = '';
  svg.classList.add('commit-graph');

  if (!graph || !graph.initialized) {
    svg.setAttribute('viewBox', '0 0 320 120');
    svg.setAttribute('width', '320');
    svg.setAttribute('height', '120');
    svg.appendChild(text('no repository yet', { x: 160, y: 56, class: 'graph-empty', 'text-anchor': 'middle' }));
    svg.appendChild(text('run `git init` to begin', { x: 160, y: 78, class: 'graph-empty-sub', 'text-anchor': 'middle' }));
    return { width: 320, height: 120 };
  }
  if (!graph.commits.length) {
    svg.setAttribute('viewBox', '0 0 320 120');
    svg.setAttribute('width', '320');
    svg.setAttribute('height', '120');
    svg.appendChild(text('empty repository', { x: 160, y: 56, class: 'graph-empty', 'text-anchor': 'middle' }));
    svg.appendChild(text('your first commit will appear here', { x: 160, y: 78, class: 'graph-empty-sub', 'text-anchor': 'middle' }));
    return { width: 320, height: 120 };
  }

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
    const lane = laneFor(c.branchHint);
    pos.set(c.id, { x: X_START + i * X_STEP, y: 0, lane });
  });
  const usedLanes = Math.max(1, ...[...pos.values()].map((p) => p.lane + 1));

  /* ---- collect ref labels per commit ---- */
  const refsByCommit = new Map();
  const addRef = (id, label, cls) => {
    if (!id || !pos.has(id)) return;
    if (!refsByCommit.has(id)) refsByCommit.set(id, []);
    refsByCommit.get(id).push({ label, cls });
  };
  for (const b of graph.branches) {
    addRef(b.tip, b.current ? 'HEAD → ' + b.name : b.name, b.current ? 'pill-head' : 'pill-branch');
  }
  for (const r of graph.remoteBranches) addRef(r.tip, r.name, 'pill-remote');
  if (graph.head.detached && graph.head.id) addRef(graph.head.id, 'HEAD (detached)', 'pill-detached');

  const maxStack = Math.max(1, ...[...refsByCommit.values()].map((r) => r.length));
  const topPad = 18 + maxStack * 24;
  const height = topPad + usedLanes * LANE_STEP + 34;
  const width = X_START + graph.commits.length * X_STEP + 120;

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  const yOf = (lane) => topPad + lane * LANE_STEP + 10;
  for (const p of pos.values()) p.y = yOf(p.lane);

  /* ---- edges (drawn first, under nodes) ---- */
  const edges = el('g', { class: 'graph-edges' });
  for (const c of graph.commits) {
    const child = pos.get(c.id);
    c.parents.forEach((pid, idx) => {
      const parent = pos.get(pid);
      if (!parent) return;
      const laneCls = 'lane-' + ((idx === 0 ? child.lane : (pos.get(pid).lane)) % LANES);
      let d;
      if (parent.y === child.y) {
        d = `M ${parent.x} ${parent.y} L ${child.x} ${child.y}`;
      } else {
        const midX = (parent.x + child.x) / 2;
        d = `M ${parent.x} ${parent.y} C ${midX} ${parent.y}, ${midX} ${child.y}, ${child.x} ${child.y}`;
      }
      edges.appendChild(el('path', { d, class: `graph-edge ${laneCls}${idx > 0 ? ' merge-edge' : ''}` }));
    });
  }
  svg.appendChild(edges);

  /* ---- nodes ---- */
  const nodes = el('g', { class: 'graph-nodes' });
  const headId = graph.head.id;
  for (const c of graph.commits) {
    const p = pos.get(c.id);
    const g = el('g', { class: 'graph-node', transform: `translate(${p.x},${p.y})` });
    if (c.id === headId) {
      g.appendChild(el('circle', { r: NODE_R + 5, class: 'node-head-ring' }));
    }
    const circle = el('circle', { r: NODE_R, class: `node-dot lane-${p.lane % LANES}${c.parents.length > 1 ? ' node-merge' : ''}` });
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `${c.short}  ${c.message}`;
    circle.appendChild(title);
    g.appendChild(circle);
    g.appendChild(text(c.short, { y: NODE_R + 15, class: 'node-sha', 'text-anchor': 'middle' }));
    nodes.appendChild(g);
  }
  svg.appendChild(nodes);

  /* ---- ref pills ---- */
  const pills = el('g', { class: 'graph-pills' });
  for (const [id, refs] of refsByCommit) {
    const p = pos.get(id);
    refs.forEach((ref, i) => {
      const w = ref.label.length * 6.6 + 18;
      const y = p.y - NODE_R - 14 - i * 24;
      const g = el('g', { class: `graph-pill ${ref.cls}`, transform: `translate(${p.x},${y})` });
      g.appendChild(el('rect', { x: -w / 2, y: -16, width: w, height: 20, rx: 10 }));
      g.appendChild(text(ref.label, { y: -2, 'text-anchor': 'middle', class: 'pill-text' }));
      // connector tick
      g.appendChild(el('line', { x1: 0, y1: 4, x2: 0, y2: p.y - y - NODE_R - 2, class: 'pill-tick' }));
      pills.appendChild(g);
    });
  }
  svg.appendChild(pills);

  if (graph.merging) {
    svg.appendChild(text('⚠ merge in progress — fix conflicts, then git add + git commit', {
      x: X_START, y: height - 8, class: 'graph-merging',
    }));
  }

  return { width, height };
}

export default renderGraph;

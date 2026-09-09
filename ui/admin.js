/* ============================================================================
 * first-commit — course statistics
 * ----------------------------------------------------------------------------
 * The owner's view: who is here, how far they got, and which unit the class is
 * getting stuck on. Everything is computed on the server from the same progress
 * documents the learners write, so nothing here can disagree with what a
 * learner sees in their own progress pill.
 *
 * This page is gated twice: the API refuses a non-owner, and the page says so
 * plainly rather than rendering an empty dashboard.
 * ========================================================================== */

import { apiFetch, probeSession } from './progress.js';
import { openAuthDialog } from './auth.js';

const $ = (sel) => document.querySelector(sel);

const NUMBER = new Intl.NumberFormat();
const pctText = (n) => `${n}%`;

/** "3 days ago" reads faster than a timestamp when you are scanning a column. */
function ago(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'never';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function gate(kicker, title, body, action) {
  const g = $('#admin-gate');
  g.hidden = false;
  $('#admin-body').hidden = true;
  g.innerHTML = '';
  g.append(el('p', 'eyebrow', kicker), el('h1', 'admin-title', title), el('p', 'admin-blurb', body));
  if (action) g.appendChild(action);
}

/* -------------------------------- rendering ------------------------------- */

function renderTiles(stats) {
  const host = $('#admin-tiles');
  host.innerHTML = '';
  const tiles = [
    ['Learners', NUMBER.format(stats.totals.learners), `${stats.totals.neverStarted} have not started`],
    ['Active this week', NUMBER.format(stats.totals.active7), `${stats.totals.active30} in the last 30 days`],
    ['Average completion', pctText(stats.totals.averagePercent), `of ${stats.units} units`],
    ['Finished the course', NUMBER.format(stats.totals.finished), `${NUMBER.format(stats.totals.unitsCompleted)} units completed in total`],
  ];
  for (const [label, value, note] of tiles) {
    const tile = el('div', 'tile');
    tile.append(el('span', 'eyebrow', label), el('span', 'tile-value', value), el('span', 'tile-note', note));
    host.appendChild(tile);
  }
}

function renderModules(stats) {
  const host = $('#admin-modules');
  host.innerHTML = '';
  $('#admin-modules-note').textContent =
    `Share of ${stats.totals.learners} learner${stats.totals.learners === 1 ? '' : 's'} who finished every unit in the module`;
  for (const m of stats.modules_) {
    const row = el('div', 'module-row');
    row.append(
      el('span', 'module-num', String(m.number).padStart(2, '0')),
      el('span', 'module-title', m.title)
    );
    const track = el('div', 'bar-track');
    const fill = el('span', 'bar-fill');
    fill.style.width = m.percentOfLearners + '%';
    track.appendChild(fill);
    row.append(track, el('span', 'module-value', `${m.fullyCompletedBy} · ${pctText(m.percentOfLearners)}`));
    host.appendChild(row);
  }
}

function table(head, rows) {
  const t = el('table', 'admin-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of head) {
    const th = el('th', h.align ? 'align-' + h.align : null, h.label);
    if (h.width) th.style.width = h.width;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = el('tbody');
  for (const cells of rows) {
    const tr = el('tr');
    for (const c of cells) {
      const td = el('td', c.className);
      if (c.node) td.appendChild(c.node); else td.textContent = c.text ?? '';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.append(thead, tbody);
  return t;
}

function renderFunnel(stats) {
  const host = $('#admin-funnel');
  host.innerHTML = '';
  let previous = null;
  const rows = stats.funnel.map((u) => {
    const drop = previous == null ? 0 : Math.max(0, previous - u.completed);
    previous = u.completed;
    const dropCell = drop > 0
      ? { text: '−' + drop, className: 'align-right drop' }
      : { text: '·', className: 'align-right muted' };
    return [
      { text: String(u.moduleNumber).padStart(2, '0'), className: 'muted mono-cell' },
      { text: u.title },
      { text: u.type, className: 'muted' },
      { text: String(u.completed), className: 'align-right mono-cell' },
      dropCell,
    ];
  });
  host.appendChild(table([
    { label: 'Mod', width: '48px' },
    { label: 'Unit' },
    { label: 'Type', width: '96px' },
    { label: 'Completed', align: 'right', width: '96px' },
    { label: 'Drop', align: 'right', width: '72px' },
  ], rows));
}

/**
 * Destructive controls, armed by a first click and fired by a second.
 * A confirm() would be read by nobody; a button that visibly changes into the
 * consequence is harder to hit by accident.
 */
function armedButton(label, armedLabel, run) {
  const btn = el('button', 'btn btn-sm btn-ghost row-action', label);
  btn.type = 'button';
  let armed = false;
  let timer = null;
  const disarm = () => {
    armed = false;
    window.clearTimeout(timer);
    btn.textContent = label;
    btn.classList.replace('btn-danger', 'btn-ghost');
  };
  btn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      btn.textContent = armedLabel;
      btn.classList.replace('btn-ghost', 'btn-danger');
      timer = window.setTimeout(disarm, 5000);
      return;
    }
    disarm();
    btn.disabled = true;
    btn.textContent = 'Working…';
    try {
      await run();
      await loadStats();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = err.message || 'Failed';
    }
  });
  return btn;
}

function learnerActions(learner, isSelf) {
  const wrap = el('span', 'row-actions');
  if (isSelf) {
    wrap.appendChild(el('span', 'muted', 'you'));
    return wrap;
  }
  if (learner.emailVerified === false && current && current.canSendEmail) {
    const resend = el('button', 'btn btn-sm btn-ghost row-action', 'Resend');
    resend.type = 'button';
    resend.title = 'Send the confirmation email again';
    resend.addEventListener('click', async () => {
      resend.disabled = true;
      resend.textContent = 'Sending…';
      try { await apiFetch(`admin/users/${learner.id}/resend-verification`, { method: 'POST' }); resend.textContent = 'Sent'; }
      catch (err) { resend.textContent = err.message || 'Failed'; }
    });
    wrap.appendChild(resend);
  }
  wrap.append(
    armedButton('Reset', 'Erase progress?', () =>
      apiFetch(`admin/users/${learner.id}/reset-progress`, { method: 'POST' })),
    armedButton('Delete', 'Delete account?', () =>
      apiFetch(`admin/users/${learner.id}`, { method: 'DELETE' })),
  );
  return wrap;
}

function moduleSpark(learner) {
  const wrap = el('span', 'spark');
  for (const m of learner.modules) {
    const cell = el('span', 'spark-cell');
    if (m.total && m.done === m.total) cell.classList.add('is-full');
    else if (m.done > 0) cell.classList.add('is-part');
    cell.title = `Module ${m.number} — ${m.title}: ${m.done}/${m.total}`;
    wrap.appendChild(cell);
  }
  return wrap;
}

function renderLearners(stats, filter) {
  const host = $('#admin-learners');
  host.innerHTML = '';
  const q = filter.trim().toLowerCase();
  const shown = stats.learners.filter((l) =>
    !q || l.email.toLowerCase().includes(q) || (l.displayName || '').toLowerCase().includes(q));

  if (!shown.length) {
    host.appendChild(el('p', 'admin-empty',
      stats.learners.length ? 'No learner matches that filter.' : 'Nobody has signed up yet.'));
    return;
  }

  const rows = shown.map((l) => {
    const who = el('span', 'who');
    who.append(el('span', 'who-name', l.displayName || l.email));
    who.appendChild(el('span', 'who-email', l.email));
    const tags = el('span', 'who-tags');
    if (l.role === 'owner') tags.appendChild(el('span', 'badge badge-idle', 'owner'));
    if (l.emailVerified === false) tags.appendChild(el('span', 'badge badge-unverified', 'unconfirmed'));
    if (tags.childNodes.length) who.appendChild(tags);

    const bar = el('span', 'row-bar');
    const fill = el('span', 'bar-fill');
    fill.style.width = l.percent + '%';
    bar.appendChild(fill);

    return [
      { node: who },
      { node: bar, className: 'bar-cell' },
      { text: `${l.completed}/${l.total}`, className: 'align-right mono-cell' },
      { text: pctText(l.percent), className: 'align-right mono-cell' },
      { node: moduleSpark(l) },
      { text: l.lastLessonTitle || '—', className: 'muted' },
      { text: ago(l.lastSeenAt), className: 'muted align-right' },
      { node: learnerActions(l, l.id === (current && current.viewerId)), className: 'align-right' },
    ];
  });

  host.appendChild(table([
    { label: 'Learner' },
    { label: 'Progress', width: '120px' },
    { label: 'Units', align: 'right', width: '72px' },
    { label: '%', align: 'right', width: '56px' },
    { label: 'Modules', width: '140px' },
    { label: 'Last opened' },
    { label: 'Last seen', align: 'right', width: '120px' },
    { label: 'Actions', align: 'right', width: '190px' },
  ], rows));
}

/* --------------------------------- boot ----------------------------------- */

let current = null;

/** The "who are you" screen, with a button that opens the dialog. */
function signInGate() {
  const button = el('button', 'btn btn-solid btn-lg', 'Sign in');
  button.type = 'button';
  button.addEventListener('click', async () => {
    const user = await openAuthDialog({ mode: 'signin' });
    if (user) await loadStats();
  });
  gate('Owner only', 'Sign in to see the statistics',
    "This page reads every learner's progress, so it asks who you are first.", button);
}

function renderAll(stats) {
  current = stats;
  $('#admin-gate').hidden = true;
  $('#admin-body').hidden = false;
  $('#admin-generated').textContent = 'as of ' + ago(stats.generatedAt);
  renderTiles(stats);
  renderModules(stats);
  renderFunnel(stats);
  renderLearners(stats, $('#admin-search').value);
}

async function loadStats() {
  try {
    renderAll(await apiFetch('admin/stats'));
    return true;
  } catch (err) {
    if (err.status === 401) {
      signInGate();
    } else if (err.status === 403) {
      gate('Owner only', 'This page is for the course owner',
        'Your account can take the course, but not read everyone else\'s progress. ' +
        'The first account created on this server owns it.');
    } else {
      gate('Unavailable', 'No server behind this page',
        'Course statistics need the optional backend. Start it with npm start, then reload — ' +
        'served as plain static files, the course keeps progress in each browser and there is ' +
        'nothing central to report on.');
    }
    return false;
  }
}

async function boot() {
  const session = await probeSession();
  if (!session) {
    gate('Unavailable', 'No server behind this page',
      'Course statistics need the optional backend. Start it with npm start, then reload — ' +
      'served as plain static files, the course keeps progress in each browser and there is ' +
      'nothing central to report on.');
    return;
  }
  $('#admin-search').addEventListener('input', () => {
    if (current) renderLearners(current, $('#admin-search').value);
  });
  $('#admin-refresh').addEventListener('click', loadStats);

  // Nobody is signed in, so asking for the statistics would be a request we
  // already know answers 401. It works, but it puts a red error in the console
  // of every owner who opens this page signed out.
  if (!session.user) {
    signInGate();
    return;
  }
  await loadStats();
}

boot().catch((err) => {
  console.error(err);
  gate('Error', 'Could not load the statistics', String(err && err.message ? err.message : err));
});

/* ============================================================================
 * first-commit — file state panel
 * ----------------------------------------------------------------------------
 * Renders engine.getFileState(): the three areas (working directory, staging
 * area, repository/HEAD) as labelled lists, so learners can *see* files move
 * between areas as they run commands.
 *
 * Every row carries a glyph as well as a colour, and the state word is spelled
 * out — colour is never the only thing telling you what happened (R27).
 * ========================================================================== */

/** state → [glyph, chip label]. Unknown states fall back to a neutral dot. */
const STATES = {
  untracked: ['+', 'untracked'],
  added: ['+', 'new'],
  'new file': ['+', 'new'],
  modified: ['~', 'modified'],
  deleted: ['−', 'deleted'],
  conflict: ['!', 'conflict'],
  ignored: ['·', 'ignored'],
  clean: ['·', ''],
  committed: ['·', ''],
};

const AREAS = {
  working: {
    title: 'Working directory',
    sub: 'Your edits. Git sees them but is not tracking them yet.',
    empty: 'nothing changed',
  },
  index: {
    title: 'Staging area',
    sub: 'Chosen for the next commit.',
    empty: 'git add <file> to stage',
  },
  repo: {
    title: 'Repository',
    sub: 'Committed history. Safe.',
    empty: 'no commits yet',
  },
};

function fileRow(file) {
  const [glyph, chipText] = STATES[file.state] || ['·', file.state];
  const li = document.createElement('li');
  li.className = `fs-file fs-${String(file.state).replace(/\s+/g, '-')}`;

  const g = document.createElement('span');
  g.className = 'fs-glyph';
  g.setAttribute('aria-hidden', 'true');
  g.textContent = glyph;

  const name = document.createElement('span');
  name.className = 'fs-name';
  // Nested paths can outrun the panel; the full path stays available on hover.
  name.textContent = file.path;
  name.title = file.path;

  li.append(g, name);

  if (chipText) {
    const chip = document.createElement('span');
    chip.className = 'fs-chip';
    chip.textContent = chipText;
    li.appendChild(chip);
  }
  return li;
}

function area(key, files) {
  const meta = AREAS[key];
  const wrap = document.createElement('section');
  wrap.className = 'fs-area';

  const head = document.createElement('div');
  head.className = 'fs-area-head';
  const title = document.createElement('span');
  title.className = 'fs-area-title';
  title.textContent = meta.title;
  const rule = document.createElement('span');
  rule.className = 'fs-rule';
  rule.setAttribute('aria-hidden', 'true');
  const count = document.createElement('span');
  count.className = 'fs-count';
  count.textContent = files.length ? String(files.length) : '';
  head.append(title, rule, count);

  const sub = document.createElement('p');
  sub.className = 'fs-area-sub';
  sub.textContent = meta.sub;

  wrap.append(head, sub);

  if (!files.length) {
    const empty = document.createElement('p');
    empty.className = 'fs-empty';
    empty.textContent = meta.empty;
    wrap.appendChild(empty);
    return wrap;
  }

  const list = document.createElement('ul');
  list.className = 'fs-list';
  for (const f of files) list.appendChild(fileRow(f));
  wrap.appendChild(list);
  return wrap;
}

/**
 * @param {HTMLElement} root
 * @param {object} state engine.getFileState() result
 */
export function renderFiles(root, state) {
  root.innerHTML = '';
  root.classList.add('fs-panel');

  // Before `git init` the staging area and history do not exist yet — saying
  // so is more useful than three empty lists that imply they do.
  if (!state.initialized) {
    const note = document.createElement('div');
    note.className = 'fs-norepo';
    note.innerHTML = '<span class="fs-norepo-mark" aria-hidden="true"></span>' +
      '<span class="fs-norepo-title"></span><span class="fs-norepo-sub"></span>';
    note.querySelector('.fs-norepo-title').textContent = 'Nothing tracked yet';
    note.querySelector('.fs-norepo-sub').textContent = 'git init  starts the three areas';
    root.appendChild(note);
    // The folder itself is real even without a repository, so still show it.
    if (state.working.length) root.appendChild(area('working', state.working));
    return;
  }

  root.appendChild(area('working', state.working));
  root.appendChild(area('index', state.index));
  root.appendChild(area('repo', state.repo));
}

export default renderFiles;

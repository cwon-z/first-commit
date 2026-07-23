/* ============================================================================
 * first-commit — file state panel
 * ----------------------------------------------------------------------------
 * Renders engine.getFileState(): the three areas (working directory, staging
 * area, repository/HEAD) as labeled lists with status chips, so learners can
 * *see* files move between areas as they run commands.
 * ========================================================================== */

const CHIP_LABEL = {
  untracked: 'untracked',
  modified: 'modified',
  deleted: 'deleted',
  added: 'staged (new)',
  'new file': 'staged (new)',
  conflict: 'conflict!',
  ignored: 'ignored',
  clean: '',
  committed: '',
};

function section(title, subtitle, files, emptyText) {
  const wrap = document.createElement('div');
  wrap.className = 'fs-area';
  const h = document.createElement('div');
  h.className = 'fs-area-head';
  h.innerHTML = `<span class="fs-area-title"></span><span class="fs-area-sub"></span>`;
  h.querySelector('.fs-area-title').textContent = title;
  h.querySelector('.fs-area-sub').textContent = subtitle;
  wrap.appendChild(h);

  const list = document.createElement('ul');
  list.className = 'fs-list';
  if (!files.length) {
    const li = document.createElement('li');
    li.className = 'fs-empty';
    li.textContent = emptyText;
    list.appendChild(li);
  } else {
    for (const f of files) {
      const li = document.createElement('li');
      li.className = `fs-file fs-${f.state}`;
      const dot = document.createElement('span');
      dot.className = 'fs-dot';
      const name = document.createElement('span');
      name.className = 'fs-name';
      name.textContent = f.path;
      li.append(dot, name);
      const chipText = CHIP_LABEL[f.state] ?? f.state;
      if (chipText) {
        const chip = document.createElement('span');
        chip.className = 'fs-chip';
        chip.textContent = chipText;
        li.appendChild(chip);
      }
      list.appendChild(li);
    }
  }
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

  root.appendChild(section(
    'Working Directory', 'your actual files',
    state.working,
    'no files yet — try  echo "hi" > file.txt'
  ));

  if (state.initialized) {
    root.appendChild(section(
      'Staging Area', 'what the next commit will contain',
      state.index,
      'nothing staged — use  git add <file>'
    ));
    root.appendChild(section(
      'Repository (HEAD)', 'files in the latest commit',
      state.repo,
      'no commits yet — use  git commit'
    ));
  } else {
    const note = document.createElement('div');
    note.className = 'fs-noinit';
    note.textContent = 'No repository here yet. Run  git init  to unlock the staging area and history.';
    root.appendChild(note);
  }
}

export default renderFiles;

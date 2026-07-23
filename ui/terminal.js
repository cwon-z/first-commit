/* ============================================================================
 * first-commit — terminal component
 * ----------------------------------------------------------------------------
 * A DOM terminal emulator: monospace output, blinking cursor, command history
 * (↑/↓), tab-completion, and git-aware output colorization. It knows nothing
 * about git itself — it hands the typed line to `onCommand` and prints
 * whatever comes back.
 * ========================================================================== */

export class Terminal {
  /**
   * @param {HTMLElement} root
   * @param {{ onCommand: (line:string)=>void, completer?: ()=>object, promptText?: ()=>string }} opts
   */
  constructor(root, opts) {
    this.root = root;
    this.onCommand = opts.onCommand;
    this.completer = opts.completer || (() => ({}));
    this.promptText = opts.promptText || (() => '~/project $');
    this.history = [];
    this.historyIdx = -1;
    this.draft = '';

    root.classList.add('terminal');
    root.innerHTML = '';
    this.out = document.createElement('div');
    this.out.className = 'term-out';
    this.out.setAttribute('aria-live', 'polite');

    this.inputLine = document.createElement('div');
    this.inputLine.className = 'term-inputline';
    this.promptEl = document.createElement('span');
    this.promptEl.className = 'term-prompt';
    this.input = document.createElement('input');
    this.input.className = 'term-input';
    this.input.type = 'text';
    this.input.autocomplete = 'off';
    this.input.autocapitalize = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', 'terminal input');
    this.inputLine.append(this.promptEl, this.input);

    root.append(this.out, this.inputLine);
    this.refreshPrompt();

    root.addEventListener('mouseup', () => {
      // don't steal focus if the user is selecting text to copy
      if (!window.getSelection()?.toString()) this.input.focus();
    });
    this.input.addEventListener('keydown', (ev) => this.onKey(ev));
  }

  refreshPrompt() {
    this.promptEl.textContent = this.promptText();
  }

  onKey(ev) {
    if (ev.key === 'Enter') {
      const line = this.input.value;
      this.input.value = '';
      this.echo(line);
      if (line.trim()) {
        this.history.push(line);
      }
      this.historyIdx = -1;
      this.draft = '';
      this.onCommand(line);
      this.refreshPrompt();
      this.scrollToEnd();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!this.history.length) return;
      if (this.historyIdx === -1) {
        this.draft = this.input.value;
        this.historyIdx = this.history.length - 1;
      } else if (this.historyIdx > 0) {
        this.historyIdx--;
      }
      this.input.value = this.history[this.historyIdx];
      requestAnimationFrame(() => this.input.setSelectionRange(1e9, 1e9));
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (this.historyIdx === -1) return;
      this.historyIdx++;
      if (this.historyIdx >= this.history.length) {
        this.historyIdx = -1;
        this.input.value = this.draft;
      } else {
        this.input.value = this.history[this.historyIdx];
      }
    } else if (ev.key === 'Tab') {
      ev.preventDefault();
      this.complete();
    } else if (ev.key === 'l' && ev.ctrlKey) {
      ev.preventDefault();
      this.clear();
    } else if (ev.key === 'c' && ev.ctrlKey && !window.getSelection()?.toString()) {
      ev.preventDefault();
      this.echo(this.input.value + '^C');
      this.input.value = '';
      this.historyIdx = -1;
    }
  }

  complete() {
    const val = this.input.value;
    const parts = val.split(/\s+/);
    const last = parts[parts.length - 1] || '';
    const c = this.completer();
    let pool = [];
    if (parts.length <= 1) pool = c.commands || [];
    else if (parts[0] === 'git' && parts.length === 2) pool = c.gitSubcommands || [];
    else pool = [...(c.files || []), ...(c.branches || [])];
    const matches = pool.filter((p) => p.startsWith(last) && p !== last);
    if (matches.length === 1) {
      parts[parts.length - 1] = matches[0];
      this.input.value = parts.join(' ') + (parts.length <= 2 ? ' ' : '');
    } else if (matches.length > 1) {
      // extend to longest common prefix; show options
      let prefix = matches[0];
      for (const m of matches) {
        while (!m.startsWith(prefix)) prefix = prefix.slice(0, -1);
      }
      if (prefix.length > last.length) {
        parts[parts.length - 1] = prefix;
        this.input.value = parts.join(' ');
      } else {
        this.echo(val);
        this.print(matches.join('  '), 'dim');
        this.scrollToEnd();
      }
    }
  }

  /** Echo the typed command with its prompt. */
  echo(line) {
    const row = document.createElement('div');
    row.className = 'term-line term-cmdline';
    const p = document.createElement('span');
    p.className = 'term-prompt';
    p.textContent = this.promptText() + ' ';
    const cmd = document.createElement('span');
    cmd.className = 'term-cmd';
    cmd.textContent = line;
    row.append(p, cmd);
    this.out.appendChild(row);
  }

  /** Print multi-line output with git-aware colorization. */
  print(text, forceClass = null) {
    if (text == null || text === '') return;
    let section = null; // status section state machine
    for (const line of String(text).split('\n')) {
      const div = document.createElement('div');
      div.className = 'term-line';
      let cls = forceClass;
      if (!cls) {
        if (/^Changes to be committed:/.test(line)) { section = 'staged'; cls = 'plain'; }
        else if (/^(Changes not staged for commit:|Unmerged paths:)/.test(line)) { section = 'unstaged'; cls = 'plain'; }
        else if (/^Untracked files:/.test(line)) { section = 'untracked'; cls = 'plain'; }
        else if (/^(On branch|HEAD detached|No commits yet|nothing to commit|nothing added)/.test(line)) { section = null; cls = 'plain'; }
        else if (/^\t/.test(line) && section === 'staged') cls = 'green';
        else if (/^\t/.test(line) && (section === 'unstaged' || section === 'untracked')) cls = 'red';
        else if (/^\+\+\+|^---(?!-)/.test(line) && /\/dev\/null|^\+\+\+ b\/|^--- a\//.test(line)) cls = 'bold';
        else if (/^@@/.test(line)) cls = 'cyan';
        else if (/^\+/.test(line)) cls = 'green';
        else if (/^-/.test(line)) cls = 'red';
        else if (/^(diff --git|index |new file mode|deleted file mode)/.test(line)) cls = 'bold';
        else if (/^(error:|fatal:|CONFLICT| ! \[rejected\])/.test(line)) cls = 'err';
        else if (/^(hint:|  \(use |\(real git)/.test(line)) cls = 'dim';
        else if (/^commit [0-9a-f]{40}/.test(line)) cls = 'yellow';
        else if (/^(Author:|Date:|Merge:)/.test(line)) cls = 'plain';
        else if (/^[0-9a-f]{7} (\(|HEAD@)/.test(line) || /^[0-9a-f]{7} /.test(line)) cls = 'yellowsha';
        else cls = 'plain';
      }
      if (cls === 'yellowsha') {
        // color just the leading sha
        const sha = document.createElement('span');
        sha.className = 'term-yellow';
        sha.textContent = line.slice(0, 7);
        const restSpan = document.createElement('span');
        restSpan.textContent = line.slice(7);
        div.append(sha, restSpan);
      } else {
        div.textContent = line === '' ? ' ' : line;
        div.classList.add('term-' + cls);
      }
      this.out.appendChild(div);
    }
    this.scrollToEnd();
  }

  printBlank() {
    const div = document.createElement('div');
    div.className = 'term-line';
    div.textContent = ' ';
    this.out.appendChild(div);
  }

  clear() {
    this.out.innerHTML = '';
  }

  scrollToEnd() {
    this.root.scrollTop = this.root.scrollHeight;
  }

  focus() {
    this.input.focus({ preventScroll: true });
  }
}

export default Terminal;

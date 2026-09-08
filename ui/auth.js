/* ============================================================================
 * first-commit — accounts, client side
 * ----------------------------------------------------------------------------
 * The account control in the top bar and the dialog behind it.
 *
 * Signing in is optional and stays optional: without a server the control never
 * appears, and with one a learner can work as a guest all the way through. What
 * an account buys is progress that follows you to another device — so that is
 * what the dialog says, rather than demanding a sign-up before the first lesson.
 * ========================================================================== */

import { apiFetch } from './progress.js';
import { icon } from './icons.js';

export const signIn = (email, password) =>
  apiFetch('auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });

export const signUp = (email, password, displayName) =>
  apiFetch('auth/register', { method: 'POST', body: JSON.stringify({ email, password, displayName }) });

export const signOut = () => apiFetch('auth/logout', { method: 'POST' });

/* --------------------------------- dialog --------------------------------- */

function field(form, { label, type, name, autocomplete, hint }) {
  const wrap = document.createElement('label');
  wrap.className = 'auth-field';
  const text = document.createElement('span');
  text.className = 'auth-label';
  text.textContent = label;
  const input = document.createElement('input');
  input.type = type;
  input.name = name;
  input.required = true;
  input.autocomplete = autocomplete;
  input.className = 'auth-input';
  if (type === 'email') input.inputMode = 'email';
  wrap.append(text, input);
  if (hint) {
    const h = document.createElement('span');
    h.className = 'auth-hint';
    h.textContent = hint;
    wrap.appendChild(h);
  }
  form.appendChild(wrap);
  return input;
}

/**
 * @param {{ mode?: 'signin'|'signup', minPassword?: number, needsOwner?: boolean }} opts
 * @returns {Promise<object|null>} the signed-in user, or null if dismissed
 */
export function openAuthDialog(opts = {}) {
  return new Promise((resolve) => {
    let mode = opts.mode || (opts.needsOwner ? 'signup' : 'signin');
    const minPassword = opts.minPassword || 10;

    const overlay = document.createElement('div');
    overlay.className = 'auth-overlay';

    const card = document.createElement('div');
    card.className = 'auth-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'auth-title');

    const kicker = document.createElement('p');
    kicker.className = 'eyebrow';
    const title = document.createElement('h2');
    title.className = 'auth-title';
    title.id = 'auth-title';
    const blurb = document.createElement('p');
    blurb.className = 'auth-blurb';

    const form = document.createElement('form');
    form.className = 'auth-form';
    form.noValidate = true;

    const error = document.createElement('p');
    error.className = 'auth-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn btn-solid btn-lg';

    const swap = document.createElement('button');
    swap.type = 'button';
    swap.className = 'btn btn-ghost btn-sm auth-swap';

    const guest = document.createElement('button');
    guest.type = 'button';
    guest.className = 'btn btn-ghost btn-sm';
    guest.textContent = 'Keep working without an account';

    const actions = document.createElement('div');
    actions.className = 'auth-actions';
    actions.append(submit, swap);

    card.append(kicker, title, blurb, form, error, actions, guest);
    overlay.appendChild(card);

    let nameInput = null;
    let emailInput = null;
    let passwordInput = null;

    function build() {
      form.innerHTML = '';
      const signup = mode === 'signup';
      kicker.textContent = signup ? 'Create an account' : 'Welcome back';
      title.textContent = signup
        ? (opts.needsOwner ? 'Set up the course' : 'Save your progress')
        : 'Sign in';
      blurb.textContent = opts.needsOwner && signup
        ? 'Nobody has signed up yet, so this first account becomes the course owner — the only one that can see the statistics page.'
        : signup
          ? 'An account keeps your progress on the server, so you can pick the course up on another device. Everything you have finished so far comes with you.'
          : 'Your finished lessons will load from the server.';

      if (signup) {
        nameInput = field(form, {
          label: 'Name', type: 'text', name: 'displayName', autocomplete: 'nickname',
          hint: 'Shown only to you and the course owner.',
        });
        nameInput.required = false;
      }
      emailInput = field(form, { label: 'Email', type: 'email', name: 'email', autocomplete: 'username' });
      passwordInput = field(form, {
        label: 'Password',
        type: 'password',
        name: 'password',
        autocomplete: signup ? 'new-password' : 'current-password',
        hint: signup ? `At least ${minPassword} characters.` : null,
      });

      submit.textContent = signup ? 'Create account' : 'Sign in';
      swap.textContent = signup ? 'I already have an account' : 'Create an account';
      swap.hidden = !!opts.needsOwner;
      error.hidden = true;
      (signup ? nameInput : emailInput).focus();
    }

    function fail(message) {
      error.textContent = message;
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
    }

    function close(user) {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(user || null);
    }

    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(null); return; }
      if (ev.key !== 'Tab') return;
      // Keep focus inside the dialog: it is modal, and tabbing out to a page
      // that is behind a scrim strands keyboard users.
      const focusable = card.querySelectorAll('input, button');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      submit.textContent = 'Working…';
      try {
        const email = emailInput.value.trim();
        const password = passwordInput.value;
        const body = mode === 'signup'
          ? await signUp(email, password, nameInput ? nameInput.value : '')
          : await signIn(email, password);
        close(body.user);
      } catch (err) {
        fail(err.message || 'That did not work. Try again.');
      }
    });

    swap.addEventListener('click', () => { mode = mode === 'signup' ? 'signin' : 'signup'; build(); });
    guest.addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    build();
  });
}

/* ---------------------------- the topbar control -------------------------- */

/**
 * @param {HTMLElement} host      container in the shell (empty in the markup)
 * @param {{ session: object, onChange: (user:object|null)=>Promise<void>|void }} opts
 */
export function mountAccountControl(host, { session, onChange }) {
  let user = session.user;
  let config = session.config || {};
  host.hidden = false;

  const render = () => {
    host.innerHTML = '';
    if (!user) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm';
      btn.append(icon('user'), 'Sign in');
      btn.addEventListener('click', async () => {
        const signed = await openAuthDialog(config);
        if (!signed) return;
        user = signed;
        render();
        await onChange(user);
      });
      host.appendChild(btn);
      return;
    }

    const menu = document.createElement('details');
    menu.className = 'account-menu';
    const summary = document.createElement('summary');
    summary.className = 'btn btn-sm account-summary';
    summary.append(icon('user'), user.displayName || user.email);
    menu.appendChild(summary);

    const panel = document.createElement('div');
    panel.className = 'account-panel';

    const who = document.createElement('p');
    who.className = 'account-who';
    who.textContent = user.email;
    const role = document.createElement('p');
    role.className = 'account-role';
    role.textContent = user.role === 'owner'
      ? 'Course owner — progress saved to your account'
      : 'Progress saved to your account';
    panel.append(who, role);

    if (user.role === 'owner') {
      const stats = document.createElement('a');
      stats.className = 'btn btn-sm btn-block';
      stats.href = './admin.html';
      stats.textContent = 'Course statistics';
      panel.appendChild(stats);
    }

    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'btn btn-sm btn-block btn-ghost';
    out.textContent = 'Sign out';
    out.addEventListener('click', async () => {
      await signOut().catch(() => {});
      user = null;
      config = { ...config, needsOwner: false };
      render();
      await onChange(null);
    });
    panel.appendChild(out);

    menu.appendChild(panel);
    // Clicking anywhere else closes it, the way a menu is expected to behave.
    document.addEventListener('click', (ev) => {
      if (menu.open && !menu.contains(ev.target)) menu.open = false;
    });
    host.appendChild(menu);
  };

  render();
  return { get user() { return user; } };
}

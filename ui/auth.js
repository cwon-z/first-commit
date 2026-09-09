/* ============================================================================
 * first-commit — accounts, client side
 * ----------------------------------------------------------------------------
 * The account control in the top bar, and the one dialog behind it. That dialog
 * has four faces — sign in, create an account, ask for a reset link, choose a
 * new password — because they share a shape and it is less to learn than four
 * screens.
 *
 * Signing in is optional and stays optional: without a server the control never
 * appears, and with one a learner can work as a guest all the way through. What
 * an account buys is progress that follows you to another device, so that is
 * what the dialog says, rather than demanding a sign-up before the first lesson.
 * ========================================================================== */

import { apiFetch } from './progress.js';
import { icon } from './icons.js';

export const signIn = (email, password) =>
  apiFetch('auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });

export const signUp = (email, password, displayName) =>
  apiFetch('auth/register', { method: 'POST', body: JSON.stringify({ email, password, displayName }) });

export const signOut = () => apiFetch('auth/logout', { method: 'POST' });

export const confirmEmail = (token) =>
  apiFetch('auth/verify', { method: 'POST', body: JSON.stringify({ token }) });

export const resendVerification = () =>
  apiFetch('auth/resend-verification', { method: 'POST', body: JSON.stringify({}) });

export const requestReset = (email) =>
  apiFetch('auth/forgot', { method: 'POST', body: JSON.stringify({ email }) });

export const setNewPassword = (token, password) =>
  apiFetch('auth/reset', { method: 'POST', body: JSON.stringify({ token, password }) });

export const deleteAccount = () => apiFetch('account', { method: 'DELETE' });

/* --------------------------------- dialog --------------------------------- */

function field(form, { label, type, name, autocomplete, hint, required = true }) {
  const wrap = document.createElement('label');
  wrap.className = 'auth-field';
  const text = document.createElement('span');
  text.className = 'auth-label';
  text.textContent = label;
  const input = document.createElement('input');
  input.type = type;
  input.name = name;
  input.required = required;
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

const COPY = {
  signup: {
    kicker: 'Create an account',
    title: 'Save your progress',
    blurb: 'An account keeps your progress on the server, so you can pick the course up on ' +
      'another device. Everything you have finished so far comes with you.',
    submit: 'Create account',
    swap: 'I already have an account',
  },
  signin: {
    kicker: 'Welcome back',
    title: 'Sign in',
    blurb: 'Your finished lessons will load from the server.',
    submit: 'Sign in',
    swap: 'Create an account',
  },
  forgot: {
    kicker: 'Password reset',
    title: 'Send me a link',
    blurb: 'Give the address you signed up with and a link to choose a new password is on its way.',
    submit: 'Send the link',
    swap: 'Back to signing in',
  },
  reset: {
    kicker: 'Password reset',
    title: 'Choose a new password',
    blurb: 'This link works once. Every other device signed in to your account will be signed out.',
    submit: 'Save the password',
    swap: '',
  },
};

/* The dialog's submit button sits outside the <form> for layout, so it has to
 * be associated with it explicitly. Ids must be unique for that association to
 * be unambiguous, hence the counter. */
let dialogSeq = 0;

/**
 * @param {{ mode?: 'signin'|'signup'|'forgot'|'reset', minPassword?: number,
 *           needsOwner?: boolean, canSendEmail?: boolean, token?: string }} opts
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
    form.id = `auth-form-${++dialogSeq}`;
    form.noValidate = true;

    const note = document.createElement('p');
    note.className = 'auth-note';
    note.setAttribute('role', 'status');
    note.hidden = true;

    const error = document.createElement('p');
    error.className = 'auth-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;

    const submit = document.createElement('button');
    submit.type = 'submit';
    // It is rendered in .auth-actions, outside the form, so without this it is
    // a submit button belonging to no form — and clicking it does nothing at
    // all. Keeping it outside is what lets build() reset the form's fields
    // without destroying the buttons.
    submit.setAttribute('form', form.id);
    submit.className = 'btn btn-solid btn-lg';

    const swap = document.createElement('button');
    swap.type = 'button';
    swap.className = 'btn btn-ghost btn-sm auth-swap';

    const forgot = document.createElement('button');
    forgot.type = 'button';
    forgot.className = 'btn btn-ghost btn-sm';
    forgot.textContent = 'Forgot your password?';

    const guest = document.createElement('button');
    guest.type = 'button';
    guest.className = 'btn btn-ghost btn-sm';
    guest.textContent = 'Keep working without an account';

    const actions = document.createElement('div');
    actions.className = 'auth-actions';
    actions.append(submit, swap);

    card.append(kicker, title, blurb, form, note, error, actions, forgot, guest);
    overlay.appendChild(card);

    let nameInput = null;
    let emailInput = null;
    let passwordInput = null;

    function build() {
      const copy = COPY[mode];
      form.innerHTML = '';
      nameInput = emailInput = passwordInput = null;

      kicker.textContent = copy.kicker;
      title.textContent = mode === 'signup' && opts.needsOwner ? 'Set up the course' : copy.title;
      blurb.textContent = mode === 'signup' && opts.needsOwner
        ? 'Nobody has signed up yet, so this first account becomes the course owner — the only one that can see the statistics page.'
        : copy.blurb;

      if (mode === 'signup') {
        nameInput = field(form, {
          label: 'Name', type: 'text', name: 'displayName', autocomplete: 'nickname',
          hint: 'Shown only to you and the course owner.', required: false,
        });
      }
      if (mode !== 'reset') {
        emailInput = field(form, { label: 'Email', type: 'email', name: 'email', autocomplete: 'username' });
      }
      if (mode === 'signin' || mode === 'signup' || mode === 'reset') {
        passwordInput = field(form, {
          label: mode === 'reset' ? 'New password' : 'Password',
          type: 'password',
          name: 'password',
          autocomplete: mode === 'signin' ? 'current-password' : 'new-password',
          hint: mode === 'signin' ? null : `At least ${minPassword} characters.`,
        });
      }

      submit.textContent = copy.submit;
      submit.disabled = false;
      swap.textContent = copy.swap;
      swap.hidden = !copy.swap || (mode === 'signup' && !!opts.needsOwner);
      // Only offered where it makes sense, and only when the server can send it.
      forgot.hidden = mode !== 'signin' || opts.canSendEmail === false;
      guest.hidden = mode === 'reset';
      note.hidden = true;
      error.hidden = true;
      (nameInput || emailInput || passwordInput).focus();
    }

    function fail(message) {
      error.textContent = message;
      error.hidden = false;
      note.hidden = true;
      submit.disabled = false;
      submit.textContent = COPY[mode].submit;
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
      const focusable = [...card.querySelectorAll('input, button')].filter((el) => !el.hidden && !el.disabled);
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
        const email = emailInput ? emailInput.value.trim() : '';
        const password = passwordInput ? passwordInput.value : '';
        if (mode === 'signup') { close((await signUp(email, password, nameInput ? nameInput.value : '')).user); return; }
        if (mode === 'signin') { close((await signIn(email, password)).user); return; }
        if (mode === 'reset') { close((await setNewPassword(opts.token, password)).user); return; }

        // forgot: the answer is deliberately the same whether or not the
        // address has an account, so the dialog stays open showing it.
        const body = await requestReset(email);
        note.textContent = body.message || 'If that address has an account, a reset link is on its way.';
        note.hidden = false;
        submit.disabled = true;
        submit.textContent = 'Sent';
      } catch (err) {
        fail(err.message || 'That did not work. Try again.');
      }
    });

    swap.addEventListener('click', () => {
      mode = mode === 'signup' ? 'signin' : mode === 'forgot' ? 'signin' : 'signup';
      build();
    });
    forgot.addEventListener('click', () => { mode = 'forgot'; build(); });
    guest.addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) close(null); });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    build();
  });
}

/* ---------------------------- the topbar control -------------------------- */

function panelButton(label, className = 'btn btn-sm btn-block') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  return b;
}

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
    if (user.emailVerified === false) {
      const dot = document.createElement('span');
      dot.className = 'account-flag';
      dot.title = 'Email not confirmed';
      summary.appendChild(dot);
    }
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

    if (user.emailVerified === false) {
      const warn = document.createElement('div');
      warn.className = 'account-unverified';
      warn.textContent = config.canSendEmail
        ? 'Confirm your email to be able to reset your password later.'
        : 'Email is not confirmed, and this server cannot send mail.';
      panel.appendChild(warn);

      if (config.canSendEmail) {
        const resend = panelButton('Send the link again');
        resend.addEventListener('click', async () => {
          resend.disabled = true;
          resend.textContent = 'Sending…';
          try { await resendVerification(); resend.textContent = 'Sent — check your inbox'; }
          catch { resend.textContent = 'Could not send it'; }
        });
        panel.appendChild(resend);
      }
    }

    if (user.role === 'owner') {
      const stats = document.createElement('a');
      stats.className = 'btn btn-sm btn-block';
      stats.href = './admin.html';
      stats.textContent = 'Course statistics';
      panel.appendChild(stats);
    }

    const data = document.createElement('a');
    data.className = 'btn btn-sm btn-block btn-ghost';
    data.href = './api/account/export';
    data.setAttribute('download', 'first-commit-account.json');
    data.textContent = 'Download my data';
    panel.appendChild(data);

    const out = panelButton('Sign out', 'btn btn-sm btn-block btn-ghost');
    out.addEventListener('click', async () => {
      await signOut().catch(() => {});
      user = null;
      config = { ...config, needsOwner: false };
      render();
      await onChange(null);
    });
    panel.appendChild(out);

    // Destructive, so it asks twice — the same two-tap pattern as resetting
    // progress, rather than a confirm() nobody reads.
    let armed = false;
    const del = panelButton('Delete my account', 'btn btn-sm btn-block btn-ghost');
    del.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        del.textContent = 'Tap again — this erases everything';
        del.classList.replace('btn-ghost', 'btn-danger');
        window.setTimeout(() => {
          if (!armed) return;
          armed = false;
          del.textContent = 'Delete my account';
          del.classList.replace('btn-danger', 'btn-ghost');
        }, 5000);
        return;
      }
      try {
        await deleteAccount();
        user = null;
        render();
        await onChange(null);
      } catch (err) {
        del.textContent = err.message || 'Could not delete it';
      }
    });
    panel.appendChild(del);

    menu.appendChild(panel);
    // Clicking anywhere else closes it, the way a menu is expected to behave.
    document.addEventListener('click', (ev) => {
      if (menu.open && !menu.contains(ev.target)) menu.open = false;
    });
    host.appendChild(menu);
  };

  render();
  return {
    get user() { return user; },
    set(next) { user = next; render(); },
  };
}

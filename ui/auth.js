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

/* Ids have to be unique for label/aria wiring to be unambiguous, and a dialog
 * can be opened more than once per page life. */
let dialogSeq = 0;

/**
 * One labelled input, with the hint and the error message wired to it for a
 * screen reader. Returns a small handle rather than the bare element, because
 * every caller needs to be able to mark it wrong and clear it again.
 */
function field(form, {
  id, label, type, name, autocomplete, hint, required = true, reveal = false,
}) {
  const wrap = document.createElement('div');
  wrap.className = 'auth-field';

  const labelEl = document.createElement('label');
  labelEl.className = 'auth-label';
  labelEl.htmlFor = id;
  labelEl.textContent = label;

  const control = document.createElement('div');
  control.className = 'auth-control';

  const input = document.createElement('input');
  input.id = id;
  input.type = type;
  input.name = name;
  input.required = required;
  input.autocomplete = autocomplete;
  input.className = 'auth-input';
  if (type === 'email') input.inputMode = 'email';
  control.appendChild(input);

  if (reveal) {
    // A password you cannot read is a password you mistype. Offering to show it
    // is worth more than the shoulder-surfing it risks, as long as it is off by
    // default and says which state it is in.
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'auth-reveal';
    eye.textContent = 'Show';
    eye.setAttribute('aria-controls', id);
    eye.setAttribute('aria-pressed', 'false');
    eye.addEventListener('click', () => {
      const shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      eye.textContent = shown ? 'Show' : 'Hide';
      eye.setAttribute('aria-pressed', String(!shown));
      eye.setAttribute('aria-label', shown ? 'Show the password' : 'Hide the password');
      input.focus();
    });
    control.appendChild(eye);
  }

  const describedBy = [];
  let hintEl = null;
  if (hint) {
    hintEl = document.createElement('p');
    hintEl.className = 'auth-hint';
    hintEl.id = `${id}-hint`;
    hintEl.textContent = hint;
    describedBy.push(hintEl.id);
  }

  const errorEl = document.createElement('p');
  errorEl.className = 'auth-field-error';
  errorEl.id = `${id}-error`;
  errorEl.hidden = true;
  describedBy.push(errorEl.id);

  input.setAttribute('aria-describedby', describedBy.join(' '));
  wrap.append(labelEl, control);
  if (hintEl) wrap.appendChild(hintEl);
  wrap.appendChild(errorEl);
  form.appendChild(wrap);

  const handle = {
    input,
    get value() { return input.value; },
    setError(message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
      input.setAttribute('aria-invalid', 'true');
    },
    clear() {
      errorEl.hidden = true;
      input.removeAttribute('aria-invalid');
    },
  };
  // Clear as soon as they start fixing it; leaving a stale red message under a
  // field somebody is actively correcting is just nagging.
  input.addEventListener('input', handle.clear);
  return handle;
}

const COPY = {
  signup: {
    kicker: 'Create an account',
    title: 'Save your progress',
    blurb: 'Your progress is kept on the server instead of in this browser, so you can carry on ' +
      'from a different device. Everything you have finished so far comes with you.',
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

/** Deliberately loose, and only to catch typing slips before a round trip. */
const looksLikeEmail = (value) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value.trim());

/**
 * @param {{ mode?: 'signin'|'signup'|'forgot'|'reset', minPassword?: number,
 *           needsOwner?: boolean, canSendEmail?: boolean, token?: string }} opts
 * @returns {Promise<object|null>} the signed-in user, or null if dismissed
 */
export function openAuthDialog(opts = {}) {
  return new Promise((resolve) => {
    let mode = opts.mode || (opts.needsOwner ? 'signup' : 'signin');
    const minPassword = opts.minPassword || 10;
    const seq = ++dialogSeq;

    const overlay = document.createElement('div');
    overlay.className = 'auth-overlay';

    const card = document.createElement('div');
    card.className = 'auth-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', `auth-title-${seq}`);

    const kicker = document.createElement('p');
    kicker.className = 'eyebrow';
    const title = document.createElement('h2');
    title.className = 'auth-title';
    title.id = `auth-title-${seq}`;
    const blurb = document.createElement('p');
    blurb.className = 'auth-blurb';

    const form = document.createElement('form');
    form.className = 'auth-form';
    form.id = `auth-form-${seq}`;
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
    // all. Keeping it outside is what lets build() rebuild the fields without
    // destroying the buttons.
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

    let fields = {};

    function build() {
      const copy = COPY[mode];
      const signup = mode === 'signup';
      form.innerHTML = '';
      fields = {};

      kicker.textContent = copy.kicker;
      title.textContent = signup && opts.needsOwner ? 'Set up the course' : copy.title;
      blurb.textContent = signup && opts.needsOwner
        ? 'Nobody has signed up yet, so this first account becomes the course owner — the only one that can see the statistics page.'
        : copy.blurb;

      if (signup) {
        fields.name = field(form, {
          id: `auth-name-${seq}`, label: 'Name (optional)', type: 'text',
          name: 'displayName', autocomplete: 'nickname', required: false,
          hint: 'Shown only to you and the course owner.',
        });
      }
      if (mode !== 'reset') {
        fields.email = field(form, {
          id: `auth-email-${seq}`, label: 'Email', type: 'email',
          name: 'email', autocomplete: 'username',
        });
      }
      if (mode !== 'forgot') {
        fields.password = field(form, {
          id: `auth-password-${seq}`,
          label: mode === 'reset' ? 'New password' : 'Password',
          type: 'password',
          name: 'password',
          autocomplete: mode === 'signin' ? 'current-password' : 'new-password',
          hint: mode === 'signin' ? null : `At least ${minPassword} characters.`,
          reveal: mode !== 'signin',
        });
      }
      if (signup || mode === 'reset') {
        // Typing it twice is the only protection against setting a password you
        // cannot reproduce — there is nothing to compare against afterwards.
        fields.confirm = field(form, {
          id: `auth-confirm-${seq}`,
          label: 'Confirm password',
          type: 'password',
          name: 'confirmPassword',
          autocomplete: 'new-password',
        });
        // Tell them while they type, not after they submit.
        const compare = () => {
          const a = fields.password.value;
          const b = fields.confirm.value;
          if (b && a && a !== b) fields.confirm.setError('The two passwords are different.');
          else fields.confirm.clear();
        };
        fields.confirm.input.addEventListener('blur', compare);
        fields.password.input.addEventListener('input', () => {
          if (fields.confirm.value) compare();
        });
      }

      submit.textContent = copy.submit;
      submit.disabled = false;
      swap.textContent = copy.swap;
      swap.hidden = !copy.swap || (signup && !!opts.needsOwner);
      // Only offered where it makes sense, and only when the server can send it.
      forgot.hidden = mode !== 'signin' || opts.canSendEmail === false;
      guest.hidden = mode === 'reset';
      note.hidden = true;
      error.hidden = true;
      (fields.name || fields.email || fields.password).input.focus();
    }

    /** @returns {boolean} true when it is worth sending to the server. */
    function validate() {
      const problems = [];
      if (fields.email && !looksLikeEmail(fields.email.value)) {
        fields.email.setError('That does not look like an email address.');
        problems.push(fields.email);
      }
      if (fields.password && mode !== 'signin' && fields.password.value.length < minPassword) {
        fields.password.setError(`Use at least ${minPassword} characters.`);
        problems.push(fields.password);
      }
      if (fields.password && mode === 'signin' && !fields.password.value) {
        fields.password.setError('Enter your password.');
        problems.push(fields.password);
      }
      if (fields.confirm && fields.confirm.value !== fields.password.value) {
        fields.confirm.setError('The two passwords are different.');
        problems.push(fields.confirm);
      }
      if (problems.length) problems[0].input.focus();
      return problems.length === 0;
    }

    /**
     * Put the server's complaint on the field it is about. A message about a
     * duplicate address belongs under the address, not in a banner above a form
     * the reader then has to search.
     */
    function fail(err) {
      const message = (err && err.message) || 'That did not work. Try again.';
      const status = err && err.status;
      const target = status === 409 ? fields.email
        : status === 401 ? fields.password
        : /address/i.test(message) ? fields.email
        : /password|characters/i.test(message) ? fields.password
        : null;

      if (target) {
        target.setError(message);
        target.input.focus();
      } else {
        error.textContent = message;
        error.hidden = false;
      }
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
      const focusable = [...card.querySelectorAll('input, button')]
        .filter((el) => !el.hidden && !el.disabled && el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      error.hidden = true;
      if (!validate()) return;

      submit.disabled = true;
      submit.textContent = 'Working…';
      try {
        const email = fields.email ? fields.email.value.trim() : '';
        const password = fields.password ? fields.password.value : '';
        if (mode === 'signup') { close((await signUp(email, password, fields.name ? fields.name.value : '')).user); return; }
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
        fail(err);
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

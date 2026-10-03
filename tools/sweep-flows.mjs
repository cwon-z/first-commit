/* Behavioral checks; run only against the sweep's own disposable accounts server. */
export async function sweepFlows({ base, send, evaluate, check, outbox, store, inspect }) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(50); }
    throw new Error('Timed out: ' + expression);
  };
  const go = async route => {
    await send('Page.navigate', { url: 'about:blank' });
    await send('Page.navigate', { url: base + route });
    await wait("!!document.querySelector('#account button, #account details, #landing-account button, #admin-gate button, #admin-body:not([hidden])')");
  };
  const click = selector => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.click(); })()`);
  const fill = async values => {
    await evaluate(`(() => { for (const [name, value] of Object.entries(${JSON.stringify(values)})) {
      const input = document.querySelector('.auth-form [name="' + name + '"]');
      input.value = value; input.dispatchEvent(new Event('input', {bubbles:true}));
    } })()`);
  };
  const expect = async (label, expression) => check(label, !!await evaluate(expression));
  const api = async (route, body, method = 'POST') => evaluate(`(async () => {
    const r = await fetch('./api/' + ${JSON.stringify(route)}, {
      method: ${JSON.stringify(method)}, headers: {'x-first-commit':'1','content-type':'application/json'},
      body: ${method === 'GET' ? 'undefined' : JSON.stringify(JSON.stringify(body))}
    }); return {status:r.status, body:await r.json()};
  })()`);
  const password = 'browser-sweep-password';
  await go('/app.html#/lesson/m1l1');
  await evaluate(`(async () => { const p = await import('./ui/progress.js');
    await new p.LocalStorageProgressStore().save({...p.emptyProgress(),completedLessons:['m1l1']}); })()`);
  await go('/index.html');
  await click('#landing-account button');
  await click('.auth-swap');
  await click('.auth-actions [type=submit]');
  await expect('empty signup marks invalid fields', "document.querySelectorAll('[aria-invalid=true]').length >= 2");
  await fill({ email:'browser@sweep.example', password, confirmPassword:'different' });
  await click('.auth-actions [type=submit]');
  await expect('signup mismatch stays open', "!!document.querySelector('[name=confirmPassword][aria-invalid=true]')");
  await fill({ confirmPassword:password });
  await click('.auth-reveal');
  await expect('password reveal works', "document.querySelector('[name=password]').type === 'text'");
  await evaluate("document.querySelector('[name=confirmPassword]').focus()");
  await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, text:'\r'});
  await send('Input.dispatchKeyEvent', {type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13});
  await wait("location.pathname.endsWith('/app.html') && !!document.querySelector('#account details')");
  await sleep(200);
  const merged = await api('progress', null, 'GET');
  check('landing signup with Enter merges guest progress', merged.body.progress.completedLessons.includes('m1l1'));
  await click('#account summary');
  await expect('account menu opens', "document.querySelector('#account details').open");
  await inspect('signed-in account menu');
  await evaluate("[...document.querySelectorAll('#account button')].find(b=>b.textContent==='Sign out').click()");
  await wait("!!document.querySelector('#account > button')");
  const verify = outbox.find(m => m.to === 'browser@sweep.example').text.match(/#\/verify\/(\S+)/)[1];
  await go('/app.html#/verify/' + verify);
  await wait("!!document.querySelector('#mail-banner')");
  await expect('verification while signed out does not pretend to sign in', "!!document.querySelector('#account > button')");
  await go('/app.html#/lesson/m1l1');
  await click('#account > button');
  // The baseline incorrectly paints a signed-in menu above; keep later checks independent.
  await fill({email:'browser@sweep.example',password:'wrong-password'});
  await click('.auth-actions [type=submit]');
  await wait("!!document.querySelector('[name=password][aria-invalid=true]')");
  await expect('wrong password is shown on its field', "!!document.querySelector('.auth-overlay')");
  await evaluate("[...document.querySelectorAll('.auth-card button')].find(b=>b.textContent==='Forgot your password?').click()");
  await fill({email:'browser@sweep.example'});
  await inspect('forgot password form');
  await click('.auth-actions [type=submit]');
  await wait("!!document.querySelector('.auth-note:not([hidden])')");
  const reset = outbox.at(-1).text.match(/#\/reset\/(\S+)/)[1];
  await go('/app.html#/reset/' + reset);
  await wait("!!document.querySelector('[name=confirmPassword]')");
  await inspect('reset password form');
  await fill({password,confirmPassword:password});
  await click('.auth-actions [type=submit]');
  await wait("!!document.querySelector('#account details') && !document.querySelector('.auth-overlay')");
  check('reset form signs in successfully', (await api('auth/me',null,'GET')).body.user?.email === 'browser@sweep.example');
  await go('/app.html#/reset/' + reset);
  await wait("!!document.querySelector('[name=confirmPassword]')");
  await fill({password,confirmPassword:password});
  await click('.auth-actions [type=submit]');
  await wait("!!document.querySelector('.auth-error:not([hidden])')");
  await expect('replayed reset link reports an error', "document.querySelector('.auth-error').textContent.includes('already been used')");
  await go('/app.html#/lesson/m1l1');
  // A failed logout must not paint a guest UI while the cookie remains live.
  await evaluate(`window.sweepFetch = window.fetch; window.fetch = (url, opts) =>
    String(url).endsWith('auth/logout') ? Promise.reject(new Error('simulated offline')) : window.sweepFetch(url,opts)`);
  await click('#account summary');
  await evaluate("[...document.querySelectorAll('#account button')].find(b=>b.textContent==='Sign out').click()");
  await sleep(100);
  await expect('failed logout keeps the account visible', "!!document.querySelector('#account details')");
  await evaluate("window.fetch = window.sweepFetch");
  await api('auth/logout', {});
  await go('/app.html#/lesson/m1l1');
  await click('#account > button');
  await fill({email:'pending@sweep.example',password});
  await click('.auth-swap');
  await fill({email:'pending@sweep.example',password,confirmPassword:password});
  await evaluate(`window.sweepRequests = 0; window.sweepFetch = window.fetch;
    window.fetch = async (url,opts) => {
      if (String(url).endsWith('auth/register')) { window.sweepRequests++; await new Promise(r=>setTimeout(r,300)); }
      return window.sweepFetch(url,opts);
    }`);
  await click('.auth-actions [type=submit]');
  await evaluate("document.querySelector('.auth-form').requestSubmit()");
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await expect('pending auth cannot be dismissed or switched', "!!document.querySelector('.auth-overlay') && document.querySelector('.auth-swap').disabled");
  await sleep(700);
  await expect('repeated submit sends one registration', "window.sweepRequests === 1");
  await evaluate("window.fetch = window.sweepFetch");
  await api('auth/logout',{});
  await go('/app.html#/lesson/m1l1');
  await click('#account > button');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await expect('Escape restores focus to sign-in button', "document.activeElement === document.querySelector('#account > button')");
  await click('#account > button');
  await fill({email:'browser@sweep.example',password});
  await click('.auth-actions [type=submit]');
  await wait("!!document.querySelector('#account details')");
  await go('/app.html#/lesson/m2l1');
  await click('#lesson-article .lesson-actions button');
  await wait("location.hash === '#/lesson/m2l1b'");
  await go('/app.html#/lesson/m1l3');
  await click('#reset-progress');
  await click('#reset-progress');
  await sleep(100);
  check('reset progress while an exercise is open clears completions',
    (await api('progress',null,'GET')).body.progress.completedLessons.length === 0);
  await expect('exercise still accepts commands after progress reset', "!!document.querySelector('.term-input')");
  await evaluate("document.querySelector('.term-input').value = 'git status'; document.querySelector('.term-input').focus()");
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await expect('terminal executes Enter', "document.querySelector('.term-input').value === ''");
  const browserUser = store.userByEmail('browser@sweep.example');
  await store.write(d => { for (const s of Object.values(d.sessions)) {
    if (s.userId === browserUser.id) s.expiresAt = '2000-01-01T00:00:00Z';
  } });
  await evaluate("location.hash = '#/lesson/m1l2'");
  await wait("!document.querySelector('#save-note').hidden");
  await expect('expired session reports unsaved progress', "document.querySelector('#save-note').textContent.includes('Signed out')");
  check('expired session cannot read account data', (await api('account/export',null,'GET')).status === 401);
  await api('auth/register',{email:'owner@sweep.example',password});
  await go('/admin.html');
  await wait("!!document.querySelector('#admin-learners .row-action')");
  await inspect('owner admin table');
  const learnerRow = `[...document.querySelectorAll('#admin-learners tbody tr')].find(r=>r.textContent.includes('pending@sweep.example'))`;
  await evaluate(`${learnerRow}.querySelector('button').click()`);
  await sleep(100);
  await expect('admin resend confirmation completes', `${learnerRow}.textContent.includes('Sent')`);
  await store.write(d => { d.progress[store.userByEmail('pending@sweep.example').id].completedLessons = ['m1l1']; });
  const action = async label => evaluate(`[...${learnerRow}.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
  await action('Reset');
  await action('Erase progress?');
  await sleep(150);
  check('admin reset removes learner progress', store.progressFor(store.userByEmail('pending@sweep.example').id).completedLessons.length === 0);
  await action('Delete');
  await action('Delete account?');
  await sleep(150);
  check('admin delete removes the learner account', store.userByEmail('pending@sweep.example') === null);
  await evaluate("document.querySelector('#admin-search').value='no-such-learner'; document.querySelector('#admin-search').dispatchEvent(new Event('input',{bubbles:true}))");
  await expect('admin filter renders its empty state', "document.querySelector('#admin-learners').textContent.includes('No learner matches')");
  await api('auth/logout',{});
  await go('/app.html#/lesson/m1l1');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:650,deviceScaleFactor:1,mobile:true});
  await click('#account > button');
  await expect('phone-width auth has no horizontal overflow', "document.documentElement.scrollWidth <= innerWidth");
  await send('Emulation.clearDeviceMetricsOverride');

  /* Progress saved from more than one place. Every open page saves its whole
     copy on every lesson it shows; the other tab or device is played here by
     writing exactly what it would write, then letting the real page save. */
  const eventually = async (expression) => {
    for (let i = 0; i < 60; i++) { if (await evaluate(expression)) return true; await sleep(50); }
    return false;
  };
  const until = async (test) => {
    for (let i = 0; i < 60; i++) { if (await test()) return true; await sleep(50); }
    return false;
  };
  const done = id => `!!document.querySelector('.nav-lesson.done[data-lesson="${id}"]')`;
  const guestCopy = "(JSON.parse(localStorage.getItem('first-commit.progress.v1') || '{}').completedLessons || [])";
  const offline = `window.sweepFetch = window.fetch; window.fetch = (url, opts) =>
    String(url).endsWith('api/progress') && opts && opts.method === 'PUT'
      ? Promise.reject(new TypeError('simulated offline')) : window.sweepFetch(url, opts)`;
  const finish = async (id) => {
    await evaluate(`location.hash = '#/lesson/${id}'`);
    await wait(`location.hash === '#/lesson/${id}' && !!document.querySelector('#lesson-article .lesson-actions button')`);
    await click('#lesson-article .lesson-actions button');
  };

  await evaluate('localStorage.clear()');
  await go('/app.html#/lesson/m1l1');
  await evaluate(`(async () => { const p = await import('./ui/progress.js');
    await new p.LocalStorageProgressStore().save({ completedLessons: ['m2l1', 'm2l1b'], lastLessonId: 'm2l1b' }); })()`);
  await evaluate("location.hash = '#/lesson/m1l2'");
  check("guest: another tab's work survives this page's next save", await eventually(`${guestCopy}.includes('m2l1b')`)
    && await eventually(done('m2l1b')));
  await finish('m1l1');   // so this page holds work of its own when the reset lands
  await eventually(`${guestCopy}.includes('m1l1')`);
  await evaluate(`(async () => { const p = await import('./ui/progress.js'); await new p.LocalStorageProgressStore().clear(); })()`);
  await evaluate("location.hash = '#/lesson/m1l1'");
  check('guest: a reset in another tab is not undone by this one',
    await eventually(`!document.querySelector('.nav-lesson.done') && ${guestCopy}.length === 0`));

  await api('auth/register', { email: 'devices@sweep.example', password });
  const device = store.userByEmail('devices@sweep.example');
  const onAccount = () => store.progressFor(device.id)?.completedLessons || [];
  await go('/app.html#/lesson/m1l1');
  await api('progress', { progress: { completedLessons: ['m3l1', 'm3l1b'], lastLessonId: 'm3l1b', resetAt: null } }, 'PUT');
  await evaluate("location.hash = '#/lesson/m1l2'");
  check("signed in: another device's work survives this page's next save",
    await eventually(done('m3l1b')) && onAccount().includes('m3l1b'));
  await finish('m1l1');
  await until(() => onAccount().includes('m1l1'));
  await api('progress', null, 'DELETE');
  await evaluate("location.hash = '#/lesson/m1l1'");
  check('signed in: a reset made elsewhere is not undone by this page',
    await eventually("!document.querySelector('.nav-lesson.done')") && onAccount().length === 0);

  await evaluate(offline);
  await finish('m2l1');
  check('offline: the failed save is reported',
    await eventually("!document.querySelector('#save-note').hidden && document.querySelector('#save-note').textContent.startsWith('Offline')"));
  check('offline: the unsent lesson is kept on this device',
    await evaluate(`(localStorage.getItem('first-commit.unsent.v1.${device.id}') || '').includes('m2l1')`));
  await evaluate("window.fetch = window.sweepFetch; window.dispatchEvent(new Event('online'))");
  check('offline: back online, the lesson reaches the account', await until(() => onAccount().includes('m2l1')));
  check('offline: and the note and the device copy clear',
    await eventually(`document.querySelector('#save-note').hidden && localStorage.getItem('first-commit.unsent.v1.${device.id}') === null`));
  await evaluate(offline);
  await finish('m2l1b');
  await eventually("!document.querySelector('#save-note').hidden");
  await go('/app.html#/lesson/m1l1');
  check('offline: reopening the course delivers what the closed page could not',
    await until(() => onAccount().includes('m2l1b')));

  const progressFor = store.progressFor;
  store.progressFor = () => { throw new Error('injected: progress unreadable'); };
  try {
    await go('/app.html#/lesson/m1l2');
    check('unreadable account progress still opens the course',
      await evaluate("!!document.querySelector('#lesson-article .lesson-title') && !document.querySelector('.load-error')"));
    check("and the first save that gets through brings the account's progress in", await eventually(done('m2l1b')));
  } finally {
    store.progressFor = progressFor;
  }
  await api('auth/logout', {});

  /* The terminal and the bars around it — each of these once shipped broken. */
  const typeLine = async (line) => {
    await evaluate(`(() => { const i = document.querySelector('.term-input'); i.focus(); i.value = ${JSON.stringify(line)}; })()`);
    await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  };
  const course = await (await fetch(base + '/content/course.json')).json();
  const steps = course.modules[2].lessons.find(l => l.id === 'm3l2').exercise.steps;
  await go('/app.html#/lesson/m3l2');
  for (const step of steps.slice(0, 7)) for (const line of step.cmd.split('\n')) await typeLine(line);
  await click('#step-list .step-current .step-tools button');
  check('"Run it for me" finishes a step that needs two commands', await eventually("!!document.querySelector('#success-banner')"));

  await go('/app.html#/lesson/m1l3');
  await evaluate("document.querySelector('.term-input').focus()");
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  check('Tab on an empty line leaves the terminal', await evaluate("!document.activeElement.classList.contains('term-input')"));

  await evaluate(`(() => { const i = document.querySelector('.term-input'); i.focus();
    const data = new DataTransfer(); data.setData('text/plain', 'git init\\ngit status\\ngit sta');
    i.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); })()`);
  check('a two-line paste runs both commands and keeps the unfinished third',
    await evaluate("[...document.querySelectorAll('.term-line')].some(l => l.textContent.includes('On branch')) && document.querySelector('.term-input').value === 'git sta'"));

  await go('/app.html#/lesson/m4l2');
  await typeLine('cat menu.txt');
  check('cat output is not dressed up as diff deletions', await eventually(
    "[...document.querySelectorAll('.term-line')].some(l => l.textContent.includes('apple pie')) && !document.querySelector('.term-out .term-red')"));

  await send('Emulation.setDeviceMetricsOverride',{width:1000,height:800,deviceScaleFactor:1,mobile:false});
  await go('/app.html#/lesson/m6l3');
  await typeLine('git switch -c a-rather-long-feature-branch-name');
  check('a long branch name in the prompt still leaves room to type',
    await evaluate("document.querySelector('.term-input').getBoundingClientRect().width >= 50"));

  await send('Emulation.setDeviceMetricsOverride',{width:360,height:740,deviceScaleFactor:1,mobile:true});
  await go('/app.html#/lesson/m3l3');
  check('phone: the reset button stays on screen in a challenge', await evaluate(
    "document.querySelector('#reset-btn').getBoundingClientRect().right <= innerWidth && document.documentElement.scrollWidth <= innerWidth"));
  await api('auth/register', { email: 'a-learner-with-a-long-address@sweep.example', password });
  await go('/app.html#/lesson/m1l1');
  check('phone: a long account name keeps the top bar on screen', await evaluate(
    "document.querySelector('#account').getBoundingClientRect().right <= innerWidth && document.documentElement.scrollWidth <= innerWidth"));
  // Signed in, the landing page shows a link rather than go()'s sign-in button.
  await send('Page.navigate', { url: 'about:blank' });
  await send('Page.navigate', { url: base + '/index.html' });
  await wait("!!document.querySelector('#landing-account a')");
  check('phone: and keeps "Open the course" on the landing page', await evaluate(
    "document.querySelector('.site-header > .btn-solid').getBoundingClientRect().right <= innerWidth && document.documentElement.scrollWidth <= innerWidth"));
  await send('Emulation.clearDeviceMetricsOverride');
  await api('auth/logout', {});
}

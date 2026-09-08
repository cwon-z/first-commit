/* ============================================================================
 * first-commit — landing page
 * ----------------------------------------------------------------------------
 * The curriculum grid and the video slot are rendered FROM content/course.json,
 * so the landing page can never drift out of sync with the course itself:
 * shipping a module means editing course.json and nothing else.
 *
 * This is progressive enhancement — if the fetch fails (opened over file://,
 * a 404, offline) the page still reads fine and the curriculum section falls
 * back to a link into the app.
 * ========================================================================== */

const $ = (sel) => document.querySelector(sel);

/** Concept / guided / challenge / recap, as the little badges under a card. */
function unitKinds(mod) {
  const kinds = (mod.lessons || []).map((l) => l.type || 'concept');
  if (mod.recap && mod.status === 'ready') kinds.push('recap');
  return kinds;
}

function moduleCard(mod) {
  const ready = mod.status === 'ready';
  const li = document.createElement('li');

  // The whole card is the target: a learner reading the curriculum wants to
  // start the module, not hunt for a link inside it.
  const card = document.createElement(ready && (mod.lessons || []).length ? 'a' : 'div');
  card.className = ready ? 'mod ready' : 'mod';
  if (card.tagName === 'A') card.href = `./app.html#/lesson/${mod.lessons[0].id}`;

  const top = document.createElement('div');
  top.className = 'mod-top';
  const num = document.createElement('span');
  num.className = 'mod-num';
  num.textContent = String(mod.number).padStart(2, '0');
  const tag = document.createElement('span');
  tag.className = ready ? 'badge badge-idle mod-tag' : 'badge mod-tag soon';
  tag.textContent = ready ? 'available' : 'coming soon';
  top.append(num, tag);

  const title = document.createElement('h3');
  title.textContent = mod.title;

  const summary = document.createElement('p');
  summary.textContent = mod.summary || '';

  const units = document.createElement('div');
  units.className = 'mod-units';
  for (const kind of unitKinds(mod)) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = kind;
    units.appendChild(b);
  }

  card.append(top, title, summary, units);
  li.appendChild(card);
  return li;
}

function renderCurriculum(course) {
  const grid = $('#module-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const mod of course.modules || []) grid.appendChild(moduleCard(mod));
}

/** Swap the placeholder for a real embed once meta.youtubeVideoId is set. */
function renderVideo(course) {
  const id = ((course.meta && course.meta.youtubeVideoId) || '').trim();
  const frame = $('#video-frame');
  if (!id || !frame) return;
  // Only ever treat this as a bare YouTube id — never interpolate a raw URL.
  if (!/^[\w-]{6,20}$/.test(id)) {
    console.warn('landing: ignoring malformed meta.youtubeVideoId', id);
    return;
  }
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube-nocookie.com/embed/${id}`;
  iframe.title = `${course.meta.brand} — Git course`;
  iframe.loading = 'lazy';
  iframe.allowFullscreen = true;
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute(
    'allow',
    'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture'
  );
  frame.innerHTML = '';
  frame.appendChild(iframe);
}

fetch('./content/course.json')
  .then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res.json();
  })
  .then((course) => {
    renderCurriculum(course);
    renderVideo(course);
  })
  .catch((err) => {
    const fallback = $('#curriculum-fallback');
    if (fallback) fallback.hidden = false;
    console.warn('landing: could not load course.json —', err.message);
  });

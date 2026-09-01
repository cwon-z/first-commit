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

function moduleCard(mod) {
  const li = document.createElement('li');
  li.className = mod.status === 'ready' ? 'mod ready' : 'mod';

  const num = document.createElement('span');
  num.className = 'mod-num';
  num.textContent = String(mod.number).padStart(2, '0');

  const title = document.createElement('h3');
  title.textContent = mod.title;

  const summary = document.createElement('p');
  summary.textContent = mod.summary || '';

  const tag = document.createElement('span');
  tag.className = mod.status === 'ready' ? 'mod-tag' : 'mod-tag soon';
  tag.textContent = mod.status === 'ready' ? 'available' : 'coming soon';

  li.append(num, title, summary, tag);
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

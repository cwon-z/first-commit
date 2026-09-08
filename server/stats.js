/* ============================================================================
 * first-commit — course statistics
 * ----------------------------------------------------------------------------
 * Turns the raw progress documents into the numbers the course owner actually
 * wants: who is here, how far they got, and — the useful one — which unit the
 * class is getting stuck on.
 *
 * The unit list is derived from content/course.json with the same rule the app
 * uses (every lesson, plus a recap for each ready module), so the denominator
 * on this page and the denominator in the learner's progress pill can never
 * disagree.
 * ========================================================================== */

const DAY = 24 * 60 * 60 * 1000;

/** Flatten the course to its navigable units. Mirrors `flatten()` in ui/app.js. */
export function courseUnits(course) {
  const units = [];
  for (const mod of course.modules || []) {
    for (const lesson of mod.lessons || []) {
      units.push({
        id: lesson.id,
        title: lesson.title,
        type: lesson.type,
        moduleId: mod.id,
        moduleNumber: mod.number,
        moduleTitle: mod.title,
        comingSoon: !!lesson.comingSoon,
      });
    }
    if (mod.recap && mod.status === 'ready') {
      units.push({
        id: `${mod.id}-recap`,
        title: 'Module recap',
        type: 'recap',
        moduleId: mod.id,
        moduleNumber: mod.number,
        moduleTitle: mod.title,
        comingSoon: false,
      });
    }
  }
  return units;
}

const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);

/**
 * @param {object} store  a loaded Store
 * @param {object} course content/course.json
 */
export function buildStats(store, course) {
  const units = courseUnits(course).filter((u) => !u.comingSoon);
  const unitIds = new Set(units.map((u) => u.id));
  const titleOf = new Map(units.map((u) => [u.id, u]));
  const now = Date.now();

  const modules = (course.modules || []).map((m) => ({
    id: m.id,
    number: m.number,
    title: m.title,
    unitIds: units.filter((u) => u.moduleId === m.id).map((u) => u.id),
  }));

  /* --------------------------- per-learner rows --------------------------- */
  const learners = store.listUsers().map((user) => {
    const progress = store.progressFor(user.id);
    // A completion for a lesson that has since been removed from the course
    // must not inflate anyone's percentage past 100.
    const done = (progress?.completedLessons || []).filter((id) => unitIds.has(id));
    const doneSet = new Set(done);
    const last = progress?.lastLessonId || null;

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
      updatedAt: progress?.updatedAt || null,
      completed: done.length,
      total: units.length,
      percent: pct(done.length, units.length),
      lastLessonId: last,
      lastLessonTitle: last && titleOf.has(last) ? titleOf.get(last).title : null,
      modules: modules.map((m) => ({
        number: m.number,
        title: m.title,
        done: m.unitIds.filter((id) => doneSet.has(id)).length,
        total: m.unitIds.length,
      })),
    };
  }).sort((a, b) => (b.lastSeenAt || '').localeCompare(a.lastSeenAt || ''));

  /* ----------------------------- unit funnel ------------------------------ */
  /* `reached` counts learners who finished anything at or past this unit, so a
     big drop between two rows is the place the course loses people. */
  const completions = new Map(units.map((u) => [u.id, 0]));
  for (const l of learners) {
    const progress = store.progressFor(l.id);
    for (const id of progress?.completedLessons || []) {
      if (completions.has(id)) completions.set(id, completions.get(id) + 1);
    }
  }
  let seenLater = 0;
  const funnel = units.map((u, i) => ({ ...u, index: i, completed: completions.get(u.id) })).reverse()
    .map((u) => { seenLater = Math.max(seenLater, u.completed); return { ...u, reached: seenLater }; })
    .reverse();

  /* -------------------------------- totals -------------------------------- */
  const active = (days) => learners.filter(
    (l) => l.lastSeenAt && now - Date.parse(l.lastSeenAt) < days * DAY
  ).length;
  const finished = learners.filter((l) => l.completed === units.length).length;
  const started = learners.filter((l) => l.completed > 0).length;
  const totalCompletions = learners.reduce((n, l) => n + l.completed, 0);

  return {
    generatedAt: new Date(now).toISOString(),
    units: units.length,
    modules: modules.length,
    totals: {
      learners: learners.length,
      active7: active(7),
      active30: active(30),
      started,
      finished,
      neverStarted: learners.length - started,
      unitsCompleted: totalCompletions,
      averagePercent: learners.length
        ? Math.round(learners.reduce((n, l) => n + l.percent, 0) / learners.length)
        : 0,
    },
    modules_: modules.map((m) => {
      const perLearner = learners.map((l) => m.unitIds.filter((id) => {
        const p = store.progressFor(l.id);
        return (p?.completedLessons || []).includes(id);
      }).length);
      const fully = perLearner.filter((n) => n === m.unitIds.length && n > 0).length;
      return {
        number: m.number,
        title: m.title,
        total: m.unitIds.length,
        fullyCompletedBy: fully,
        percentOfLearners: pct(fully, learners.length),
      };
    }),
    funnel,
    learners,
  };
}

export default buildStats;

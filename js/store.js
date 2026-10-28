// Learner progress, kept in localStorage. Mastery rules live here:
//   a lesson is mastered when all lenses were read, the lab was completed and the quiz passed (>= 80%);
//   the next lesson unlocks only after the previous one is mastered.

import { curriculum } from './curriculum.js';
import { toast } from './ui/dom.js';

const KEY = 'devops-conquest:v1';
export const PASS_MARK = 0.8;

// one rank per realm, at about 92% of the XP for finishing it (lab + quiz + lenses), so a
// learner who tests out of a realm or misses some perfect scores still reaches the top
export const RANKS = [
  { xp: 0, name: 'Newcomer', blurb: 'Every expert started with an empty terminal.' },
  { xp: 200, name: 'Shell Dweller', blurb: 'The command line feels like home.' },
  { xp: 1450, name: 'Sysadmin Apprentice', blurb: 'Users, permissions and processes answer to you.' },
  { xp: 2250, name: 'Network Navigator', blurb: 'Ports, DNS and TLS hold no mysteries.' },
  { xp: 2950, name: 'Service Keeper', blurb: 'Your services start, restart and log properly.' },
  { xp: 3500, name: 'Automator', blurb: 'If you did it twice, you scripted it.' },
  { xp: 4300, name: 'Pipeline Builder', blurb: 'Every change flows through your pipelines.' },
  { xp: 5350, name: 'Container Captain', blurb: 'You ship software in tidy, small images.' },
  { xp: 6400, name: 'Cluster Pilot', blurb: 'Kubernetes does what you tell it.' },
  { xp: 7500, name: 'Infra Coder', blurb: 'Your infrastructure lives in version control.' },
  { xp: 8700, name: 'Observer', blurb: 'You see problems before users do.' },
  { xp: 9650, name: 'Incident Commander', blurb: 'Calm in the storm, blameless after it.' },
  { xp: 10850, name: 'Guardian', blurb: 'Security is built in, not bolted on.' },
  { xp: 11800, name: 'AI Ops Pilot', blurb: 'You use AI as a power tool, with guardrails.' },
  { xp: 12500, name: 'DevOps Hero', blurb: 'Zero to hero: the whole loop is yours.' },
];

export const XP = { lens: 5, lab: 60, quiz: 50, perfect: 20, boss: 120, testOut: 40 };

function blank() {
  return { lessons: {}, xp: 0, missed: {}, badges: [], days: [], started: Date.now(), testedOut: [] };
}

let state = load();
const subs = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...blank(), ...JSON.parse(raw) };
  } catch { /* storage unavailable: progress lives for this visit only */ }
  return blank();
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
  for (const fn of subs) fn(state);
}

export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function getState() { return state; }

function touchDay() {
  const d = new Date().toISOString().slice(0, 10);
  if (!state.days.includes(d)) state.days.push(d);
}

export function lessonState(id) {
  return state.lessons[id] || (state.lessons[id] = { lenses: [], learned: false, lab: false, quizBest: 0, quizTries: 0, mastered: false });
}

export function addXP(n, reason) {
  const before = rankFor(state.xp);
  state.xp += n;
  const after = rankFor(state.xp);
  toast(`+${n} XP`, { sub: reason, kind: 'xp' });
  if (after.name !== before.name) setTimeout(() => toast(`Rank up: ${after.name}`, { sub: after.blurb, ms: 5000 }), 600);
}

export function rankFor(xp) {
  let r = RANKS[0];
  for (const k of RANKS) if (xp >= k.xp) r = k;
  return r;
}

export function nextRank(xp) {
  return RANKS.find(r => r.xp > xp) || null;
}

export function markLens(lessonId, lensId, total) {
  const ls = lessonState(lessonId);
  if (!ls.lenses.includes(lensId)) {
    ls.lenses.push(lensId);
    state.xp += XP.lens;
  }
  if (!ls.learned && ls.lenses.length >= total) {
    ls.learned = true;
    toast('Lesson read', { sub: 'Practice is unlocked' });
  }
  touchDay();
  save();
}

export function completeLab(lessonId) {
  const ls = lessonState(lessonId);
  if (!ls.lab) {
    ls.lab = true;
    const lesson = curriculum.byId[lessonId];
    addXP(lesson?.boss ? XP.boss : XP.lab, lesson?.boss ? 'Boss lab cleared' : 'Lab complete');
    grant('first-lab');
  }
  touchDay();
  save();
}

export function recordQuiz(lessonId, score, missedIds = []) {
  const ls = lessonState(lessonId);
  ls.quizTries = (ls.quizTries || 0) + 1;
  const firstPass = score >= PASS_MARK && ls.quizBest < PASS_MARK;
  ls.quizBest = Math.max(ls.quizBest || 0, score);
  for (const q of missedIds) state.missed[q] = { lesson: lessonId, count: (state.missed[q]?.count || 0) + 1, at: Date.now() };
  if (firstPass) {
    addXP(XP.quiz + (score === 1 && ls.quizTries === 1 ? XP.perfect : 0), score === 1 && ls.quizTries === 1 ? 'Perfect quiz on the first try' : 'Quiz passed');
    if (score === 1 && ls.quizTries === 1) grant('perfect');
  }
  checkMastery(lessonId);
  touchDay();
  save();
}

export function clearMissed(ids) {
  for (const id of ids) delete state.missed[id];
  save();
}

function checkMastery(lessonId) {
  const ls = lessonState(lessonId);
  if (ls.mastered) return;
  if (ls.learned && ls.lab && ls.quizBest >= PASS_MARK) {
    ls.mastered = true;
    ls.masteredAt = Date.now();
    const lesson = curriculum.byId[lessonId];
    toast(`Mastered: ${lesson.title}`, { sub: nextLessonAfter(lessonId) ? 'The next lesson is unlocked' : 'You finished the path', ms: 4500 });
    grant('first-mastery');
    const realm = curriculum.realmOf[lessonId];
    if (realm && realm.lessons.every(l => lessonState(l.id).mastered)) {
      grant('realm-' + realm.id);
      setTimeout(() => toast(`Realm conquered: ${realm.title}`, { sub: realm.badge || '', ms: 6000 }), 900);
    }
  }
}

export function isMastered(id) { return !!state.lessons[id]?.mastered; }

export function isUnlocked(lessonId) {
  const idx = curriculum.order.indexOf(lessonId);
  if (idx <= 0) return true;
  return isMastered(curriculum.order[idx - 1]);
}

export function nextLessonAfter(id) {
  const idx = curriculum.order.indexOf(id);
  return curriculum.order[idx + 1] || null;
}

export function currentLessonId() {
  return curriculum.order.find(id => !isMastered(id)) || null;
}

export function realmProgress(realm) {
  const done = realm.lessons.filter(l => isMastered(l.id)).length;
  return { done, total: realm.lessons.length, fraction: realm.lessons.length ? done / realm.lessons.length : 0 };
}

export function realmUnlocked(realm) {
  return isUnlocked(realm.lessons[0].id);
}

export function testOutRealm(realm) {
  for (const l of realm.lessons) {
    const ls = lessonState(l.id);
    if (!ls.mastered) { ls.mastered = true; ls.testedOut = true; ls.learned = true; ls.lab = true; ls.quizBest = Math.max(ls.quizBest, PASS_MARK); }
  }
  if (!state.testedOut.includes(realm.id)) state.testedOut.push(realm.id);
  addXP(XP.testOut * realm.lessons.length, `Tested out of ${realm.title}`);
  grant('realm-' + realm.id);
  touchDay();
  save();
}

export const BADGES = [
  { id: 'first-lab', title: 'Hands on the keys', desc: 'Finish your first lab.' },
  { id: 'first-mastery', title: 'First mastery', desc: 'Master your first lesson.' },
  { id: 'perfect', title: 'Zero defects', desc: 'Score 100% on a quiz at the first attempt.' },
  { id: 'sandbox', title: 'Free explorer', desc: 'Run 25 commands in the Sandbox.' },
  { id: 'reviewer', title: 'Spaced repetition', desc: 'Clear 5 questions from your review deck.' },
  { id: 'streak-3', title: 'Three-day streak', desc: 'Practise on three different days.' },
];

export function grant(id) {
  if (state.badges.includes(id)) return;
  state.badges.push(id);
  const b = BADGES.find(x => x.id === id) || curriculum.realms.map(r => ({ id: 'realm-' + r.id, title: r.badge, desc: `Conquer ${r.title}` })).find(x => x.id === id);
  if (b) setTimeout(() => toast(`Badge: ${b.title}`, { sub: b.desc, ms: 4500 }), 1200);
  save();
}

export function bumpSandbox() {
  state.sandboxCount = (state.sandboxCount || 0) + 1;
  if (state.sandboxCount >= 25) grant('sandbox');
  save();
}

export function checkStreak() {
  if (state.days.length >= 3) grant('streak-3');
}

export function resetAll() {
  state = blank();
  save();
}

// A progress code is the state as base64 JSON behind the storage key, so it can be pasted into
// another browser (or between the Artifact and the public site) without any file download.
export function exportProgress() {
  return `${KEY}:${btoa(unescape(encodeURIComponent(JSON.stringify(state))))}`;
}

export function parseProgress(code) {
  const text = String(code || '').trim();
  if (!text.startsWith(KEY + ':')) throw new Error('That is not a progress code from this course.');
  let data;
  try { data = JSON.parse(decodeURIComponent(escape(atob(text.slice(KEY.length + 1))))); } catch { throw new Error('The code is damaged: copy it again in full.'); }
  if (!data || typeof data !== 'object' || typeof data.xp !== 'number' || typeof data.lessons !== 'object') throw new Error('The code is damaged: copy it again in full.');
  return { ...blank(), ...data };
}

const union = (a = [], b = []) => [...new Set([...a, ...b])];

// merge keeps the best of both: every lesson's furthest progress, all badges and days, the higher XP
export function importProgress(data, mode = 'merge') {
  if (mode === 'replace') { state = { ...blank(), ...data }; save(); return; }
  const lessons = { ...state.lessons };
  for (const [id, b] of Object.entries(data.lessons)) {
    const a = lessons[id];
    lessons[id] = !a ? b : {
      ...a, ...b,
      lenses: union(a.lenses, b.lenses), learned: a.learned || b.learned, lab: a.lab || b.lab,
      quizBest: Math.max(a.quizBest || 0, b.quizBest || 0), quizTries: Math.max(a.quizTries || 0, b.quizTries || 0),
      mastered: a.mastered || b.mastered,
    };
  }
  const missed = { ...data.missed, ...state.missed };
  state = {
    ...data, ...state, lessons, missed,
    xp: Math.max(state.xp, data.xp),
    badges: union(state.badges, data.badges), days: union(state.days, data.days).sort(), testedOut: union(state.testedOut, data.testedOut),
    started: Math.min(state.started || Date.now(), data.started || Date.now()),
    sandboxCount: Math.max(state.sandboxCount || 0, data.sandboxCount || 0), reviewed: Math.max(state.reviewed || 0, data.reviewed || 0),
  };
  save();
}

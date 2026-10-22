// Assembles the realms (JS: labs + quizzes) with their lesson text (Markdown, bundled
// into content/text.js by tools/build-content.mjs) into one ordered path.

import text from './content/text.js';
import { realms as realmDefs } from './content/index.js';

export const LENS_LABELS = {
  story: 'The Story',
  analogy: 'The Analogy',
  model: 'The Mental Model',
  commands: 'The Commands',
  inside: 'Under the Hood',
  team: 'On a Real Team',
  traps: 'Traps & Tips',
  recap: 'Recap',
  brief: 'The Brief',
};

function build(defs) {
  const realms = [];
  const order = [];
  const byId = {};
  const realmOf = {};
  for (const r of defs) {
    const realm = { ...r, lessons: [] };
    r.lessons.forEach((l, i) => {
      const t = text[`${r.id}/${l.id}`] || { lenses: [], lab: null };
      const lesson = {
        ...l,
        realmId: r.id,
        index: i,
        // a lens kind used twice in one lesson is labelled by its own title, so the nav stays unambiguous
        lenses: t.lenses.map(x => ({ ...x, label: t.lenses.filter(y => y.kind === x.kind).length > 1 ? x.title : (LENS_LABELS[x.kind] || x.kind) })),
        labText: t.lab,
      };
      lesson.id = `${r.id}/${l.id}`;
      realm.lessons.push(lesson);
      order.push(lesson.id);
      byId[lesson.id] = lesson;
      realmOf[lesson.id] = realm;
    });
    realms.push(realm);
  }
  return { realms, order, byId, realmOf, realmById: Object.fromEntries(realms.map(r => [r.id, r])) };
}

export const curriculum = build(realmDefs);

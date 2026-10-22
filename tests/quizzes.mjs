// Validates every quiz question's structure and that typed answers accept their model answer.
import { realms } from '../js/content/index.js';
import { checkTyped } from '../js/ui/quiz.js';

let problems = 0, total = 0;
const bad = (id, i, msg) => { problems++; console.log(`✗ ${id} #${i}: ${msg}`); };
for (const r of realms) for (const l of r.lessons) {
  const id = `${r.id}/${l.id}`;
  const quiz = l.quiz || [];
  if (quiz.length < 5) bad(id, '-', `only ${quiz.length} questions`);
  quiz.forEach((q, i) => {
    total++;
    if (!q.q) bad(id, i, 'missing question text');
    if (!q.explain) bad(id, i, 'missing explanation');
    if (['mc', 'predict'].includes(q.type)) {
      if (!Array.isArray(q.choices) || q.choices.length < 2) bad(id, i, 'needs choices');
      else if (!(q.answer >= 0 && q.answer < q.choices.length)) bad(id, i, `answer ${q.answer} out of range`);
      if (new Set(q.choices).size !== q.choices.length) bad(id, i, 'duplicate choices');
    } else if (q.type === 'multi') {
      if (!Array.isArray(q.answer) || !q.answer.length || q.answer.some(a => a < 0 || a >= q.choices.length)) bad(id, i, 'bad multi answer');
    } else if (q.type === 'tf') {
      if (typeof q.answer !== 'boolean') bad(id, i, 'tf answer must be boolean');
    } else if (q.type === 'order') {
      if (!Array.isArray(q.items) || q.items.length < 2) bad(id, i, 'order needs items');
      if (new Set(q.items).size !== q.items.length) bad(id, i, 'duplicate order items');
    } else if (q.type === 'type') {
      if (!q.model) bad(id, i, 'type question needs a model answer');
      else if (!checkTyped(q, q.model)) bad(id, i, `model answer "${q.model}" is not accepted`);
    } else bad(id, i, `unknown type ${q.type}`);
  });
}
console.log(`\n${total} questions checked, ${problems} problems`);
process.exit(problems ? 1 : 0);

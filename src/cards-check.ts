import { loadCards, DEFAULT_CARDS_DIR } from "./cards.js";

// Card-pack validation: `npm run check:cards`. Exits non-zero on any problem,
// so card authors (and card-writing subagents) get a fast, offline check.

const dir = process.argv[2] ?? DEFAULT_CARDS_DIR;
const { cards, problems } = loadCards(dir);

for (const card of cards) {
  const optionCount = card.selection.options.length;
  const withMisconception = card.selection.options.filter(
    (o) => !o.correct && o.misconception,
  ).length;
  const distractors = optionCount - 1;
  const note =
    withMisconception < distractors
      ? `  (note: ${distractors - withMisconception} distractor(s) missing a misconception)`
      : "";
  console.log(`ok  ${card.id}  [${card.category}] ${optionCount} options${note}`);
}
for (const p of problems) console.error(`ERR ${p}`);

console.log(`\n${cards.length} card(s) valid, ${problems.length} problem(s).`);
process.exit(problems.length > 0 ? 1 : 0);

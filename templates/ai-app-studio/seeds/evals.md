This is the quality loop — where model, dataset, and prompt experiments get judged before they land.

Post an eval change as a **new message** — it goes to **@The Product Lead**'s approval queue, and the approved verdict comes back in your thread. Reply inside the thread to argue it; replies don't start a new review.

No eval yet? Ask **@The Eval Writer** to draft one first — they write the eval *before* the change, so "does it work?" has an answer you can point at:

`@The Eval Writer — write an eval for [the change you're about to make]: what it measures, ten real cases, how it's scored, and what failing means.`

**Sample eval change** (post as a new message):

> eval: summarize-thread accuracy — 20 real threads, three answer slots, scored correct / incorrect / not-enough-info. Ships at ≥80% correct with zero fabricated citations; below that, we revert.

Approved numbers belong in the **Eval Plan** doc's results log, so the next change starts from measurements instead of vibes. The **eval-craft** skill has the full how-to.

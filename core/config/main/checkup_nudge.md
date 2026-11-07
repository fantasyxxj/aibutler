
(System · routine memory checkup · not a user message)
## 🩺 Routine memory checkup

The checkup found: {{summary}}

🔴 **This is your own housekeeping, not a conversation.** Work through it in order — don't skip ahead.

### 1 · Look at the real state first
Run `memory_admin(op='doctor')`. The line above is a signal, not a diagnosis — go by what you find, not by that summary.
If it flagged suspected conflicts, run `memory_admin(op='conflict_scan')` and actually read the pairs it hands back.

### 2 · Whatever you can decide yourself, just do it — no asking, no reporting back

| What you found | What to call |
|---|---|
| An orphan node that genuinely relates to another one | `memory_admin(op='link', from_id=…, to_id=…)` |
| One node carrying several separate things | `memory_admin(op='split', id=…, parts=…)` |
| A missing claim, or a claim still left as a placeholder | `memory_upsert(id, claim='…')` — claim only; the body stays untouched |
| Two memories on the same thing concluding the opposite, and you can tell which one holds now | `memory_admin(op='arbitrate', winner=…, loser=…, reason=…)` |
| A pair that looked like a clash but isn't | `memory_admin(op='conflict_settle', a=…, b=…, verdict=…, note=…)`. 🔴 **`verdict` must be exactly one of these five words, nothing else is accepted**: `no_conflict` (not even about the same thing) · `scoped` (both hold, different contexts — the most common one) · `merged` (only if you already merged them) · `arbitrated` (you already ran arbitrate on them) · `asked_user`. Your reasoning goes in `note`, never in `verdict`. **Without this the same pair comes back every single checkup.** |
| Two near-duplicates you want to actually merge | Merge first, settle second: `memory_upsert` the one that stays, then `memory_admin(op='arbitrate', winner=…, loser=…, reason=…)` on the other, and only then settle with `merged`. 🔴 **`conflict_settle` changes neither memory** — `merged` without the merge is an empty note that hides the pair for 180 days while the duplicate stays in the graph. |

⚠️ Isolated does not mean it should be cleaned up: a standalone operating rule has nothing to link to by nature, and most shipped knowledge is exactly that shape. The test is "does it have a real relationship to another node", not "does it have an edge". No real relationship → leave it alone rather than inventing a link.

**When the findings include "pinned claims are over the length cap"**, fix them now while they are still pinned — once taken out they cannot go back in. Run `memory_admin(op='pinned')`; for each claim over 120 characters: your own node → `memory_upsert(id, claim='<the same rule, ≤120 characters>')`, it stays pinned; a shipped node (read-only) → save the short version as your own node with `links` to it, then pin it with `memory_admin(op='set_pinned', id='<your new node>')` and take the shipped one out with `memory_admin(op='set_pinned', id='<the shipped one>', on=false)` — both calls, or the long one keeps riding along.

### 3 · Speak up only for what you genuinely cannot judge — and say only that one thing
Which business rule governs · which price is right · which of their revisions is final — that is **their** decision, and no amount of cleverness derives it. Put both originals in front of them and let them pick.
Say so first before anything large: bulk demoting pinned, splitting a batch of nodes, archiving a pile of projects. Cleanup is irreversible.

**When the findings include "quick buttons … zero taps"**, ask them this way: call `get_chip_usage`, look at `stale`, pick at most 3. For each, think of a replacement that fits what memory says about their life (student · office job · raising kids · running a shop…). Say it in one sentence, then hang one `lifetime:'once'` pair per button (one group each): "Swap 'X' for 'Y'" · "Keep 'X'". Swap → `update_prompt_chips(mode='merge', remove=['X id'], chips=[Y])`; keep → `update_prompt_chips(mode='merge', keep=['X id'])`, which restarts its 14 days.

### 4 · From the first character to the last, the correct output is nothing
🔴 **Zero characters. Not one.** No opening announcement (`I'll work through the memory checkup...`), no running commentary, no closing summary (`All settled.` · `Done.` · `memory maintenance complete`). An opening line is a report about what you are going to do; a closing line is a report about what you did — and there is no report to file either way. **The only thing that earns an output this turn is a question you cannot answer yourself.** Silence here is not you being unhelpful; it is the whole point — this turn happens while they are busy with something else.
None of this may appear in your reply: how many items you scanned · what scored what · which tool you called · how the edge or node counts changed · how many orphans there were · your verdict on each pair · the phrase "memory maintenance complete" or any equivalent.
If nothing genuinely needs their decision, say nothing at all. Not even "done". Go straight back to what you were doing.
⚠️ But **doing nothing is not how you pass this turn**: the two calls in step 1 are the floor. "Nothing to do" only counts once you have looked.

- Whatever can be handled now, handle it now — don't log it as a TODO. You won't remember.
- No need to finish everything in one go. Anything left unhandled will be flagged again at the next checkup. That's by design: the system doesn't expect you to remember — it puts the current problems back in front of you each time.

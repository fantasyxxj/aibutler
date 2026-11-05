
(System · context is filling up · not a user message)
## ⚠️ Context is getting heavy — sink it now

Context: **{{pct}}%** ({{tok}} tok) · idle {{idle_min}} min. Still nothing cleared, but this is no longer a casual reminder.

Do both, this turn:

1. **`memory_upsert` everything this stretch produced** that would not survive a clear — conclusions, ruled-out options, root causes, shipped changes. Unsettled → `provisional=2`.
2. **Rewrite the file `MEMORY.md`** with `Edit`/`Write` (a file in your memory directory, not a memory node) to match where you actually are: what is unfinished, who you are waiting on, where you are stuck. Details live in the graph; the note carries only `[[pointers]]`.

Then judge whether to compact — density decides, not the number:

- Mid-conversation, or holding an unfinished task → **don't**.
- Work has come to a rest and the user is genuinely away → **`compact_context`**. That is the cheap moment.

You will be reminded again in 15 minutes if the context is still this heavy.

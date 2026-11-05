(System · save before clearing) I'm about to clear the context and restart the session. **Do both of the following**, then reply with "saved" when done.

🔴 If there is **genuinely nothing to save** this round (just cleared / only exchanged a few words / everything is already committed), don't change a single character — just reply with the four words "**nothing to save**".
   — This is not a shortcut for laziness: I will check whether the graph and the handoff note actually changed. Replying "nothing to save" when something should have been saved looks the same to me as not replying at all. But **force-saving when there's nothing to save** is equally wrong — it pollutes the graph with garbage.

## ① Save to the memory graph
Use `memory_upsert` to save active threads currently in progress, unfinished tasks, and key conclusions just reached (split into atomic nodes + connect with [[edges]], no date logs). Only save what "isn't committed yet and needs to continue after the clear." Don't re-save what's already been saved.

## ② Update the MEMORY.md handoff note
It is a file in your memory directory, not a memory node — edit it with `Edit`/`Write`.
This is the first thing you **hard-read when you wake up** — the memory graph requires a query to retrieve, but if the handoff note isn't updated, the next session starts from stale information.

Before writing each line, ask: **"If this line is gone, will I be stuck next time I wake up?"**

| This line is | Action |
|---|---|
| Where a current task is stuck / waiting for someone's reply / the first thing to do next time | **Keep** |
| A pure pointer like "something → [[some-node]]" | **Delete** — that's a second index; `memory_query` retrieves it |
| Already done | **Delete** — delete the same day it's done |
| Long-term lists, future tasks, things that might come in handy | **Delete** — those belong in the memory graph, not here |

The target is **ten lines or fewer**, not filling up a byte count. **Coming up short of ten lines is normal** — it just means you don't have that much on your plate. Don't drag in long-term todos just to fill space.

⚠️ The one exception: something that, if missed, causes irreversible consequences (production incident / data loss), and there's no summary node to point at — keep the full text for that one, then delete once a summary node is built.

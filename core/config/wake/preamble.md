(Wake load · the following is injected by the butler code at the moment you wake. **Only "where the conversation left off" and "what is still unfinished" go here — nothing else is loaded** — there is no room, look up what you need yourself.)

**Your first action on waking: `memory_query` for whatever this turn is actually about.** The context from the last session is gone, but the memory graph is still there — pull what this turn needs before answering, never answer from impression. (`memory_hot` is only a speed-up for when `memory_query` gets slow; it is not a wake ritual and on a large store it returns things unrelated to the task.)

Everything else lives in the memory store, so go get it yourself: rules and tool usage via `memory_query`, your most-checked quick-reference via `memory_admin(op='pinned')`, and the redlines via `memory_admin(op='redlines')` — those never enter the context, and the ones without a detectable trigger pattern have no automatic guard at all.

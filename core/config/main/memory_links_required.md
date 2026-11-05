⚠️ Not saved yet: `{{slug}}` is a new node with no `links`.

Memory is a graph. A query reaches a node either by its own words or by following links from a node it did hit — and a rule about *how* to do something rarely shares words with the task being asked about. Unlinked, this node is found only when someone happens to use its exact terms.

1. Think of the situations where this must come to mind — the tasks you will be doing at that moment (taking a booking, replying to a guest, changing a setting).
2. `memory_query` those situations and pick the 1–3 nodes that come up for them.
3. Call `memory_upsert` again with the same arguments plus `links="<slug> <slug>"`.

If you cannot tell which situations this is for, ask the person when it applies — their answer names the situation to query and link. Do not store it unlinked.

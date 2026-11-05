⚠️ Gate: suspected duplicate (top_score={{top}} > {{gate}})

Candidate existing node:
{{candidates}}

**Answer this one question first, then choose a path** — does the node you're trying to save change the **truth value** of the old claim above?

- **Old claim is wrong / the accepted position has changed** → this is not adding content, it's a **rewrite**.
  Read the body with `memory_section(node="{{slug}}")`, then use `memory_write` to **replace that sentence** — the goal is to make the wrong sentence **disappear from the graph**, not to append a correction below it. If both sentences stay, they'll both be returned on recall and readers won't know which one is current.
  If the claim itself needs to change, call `memory_upsert(id="{{slug}}", claim="<new claim>")` — the old id lands in place with no further gate.

- **Old claim is unchanged, this is additional detail for the same proposition** → merge it into the existing body: read it with `memory_section` first, merge, then replace the whole thing with `memory_write`.
  ⚠️ `memory_write` **only replaces, never appends** — content longer than the original will be rejected. To actually add, use `memory_upsert(body)`, but think first: anything a single proposition can't hold is probably another proposition — create a new node and link it with [[edges]]. Memory is propositions. Propositions shouldn't grow.

- **This is a different proposition** (its truth value can be judged independently — neither implies the other) → **create a new node**, don't force a merge.
  Call `memory_upsert` again with `confirm_new=true`, and link to `{{slug}}` in `links`.
  Related topic ≠ same proposition. The gate only checks surface overlap — **whether it's actually the same proposition is your call**.

- **Thought it through — there's genuinely nothing new here** → abandon saving this node.

🔴 pinned is full {{count}}/{{quota}} — **`{{id}}` was not written**. The pinned set is zero-sum: to add one, you must remove one.

Current pinned list:
{{list}}

Apply your own pinned retirement criteria and pick one:

- **Swap**: resend this `memory_upsert` call with all the same parameters, plus one more: `demote="<id of the one making way>"` — the engine will first demote it to high (body unchanged), then write yours. One call, done.
- **This node doesn't actually need to be pinned**: resend with `importance` changed to `high` — no quota consumed.

To demote a node on its own (not to make room, but because it's no longer relevant), use `memory_admin(op='set_importance')`.

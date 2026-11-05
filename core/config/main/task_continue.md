(butler auto-continue · not a user message) Your last turn ended with unfinished items on the task list:

{{left}}

**Don't stop if it's not done.** Go straight to the next item — no progress report needed, no waiting to be pushed again.

Every item on this list must end up in one of three states. Pick one now:

- **You can move it** → do the work. Mark it done with `task(op='update', id="3", status="completed")` once it actually is.
- **It no longer needs doing** → `task(op='update', id="3", status="deleted")`. Don't leave it hanging.
- **You genuinely cannot move it without the user** (needs their decision, their credentials, their restart, their go-ahead) → mark it blocked, then say what you need:

  `task(op='update', id="3", blocked="waiting on the owner to approve the migration")`

  Blocked items stay visible on the list but stop triggering this message. Clear it with `blocked: null` once the answer arrives.

🔴 Saying "I'm waiting for you" in prose does **not** register — nothing reads your reply text to decide whether to push you again. Only the task's state is read. If you are stuck, mark it blocked; otherwise you will be pushed again, and repeating the same sentence is the one outcome that helps nobody.

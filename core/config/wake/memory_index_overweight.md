
🔴 **Truncated above — your handoff note is overweight: {{kb}}KB, limit {{maxKb}}KB.** The last {{droppedLines}} lines were not shown this time.

The handoff note is not the memory itself. It gets re-read with the context every single turn — every 1KB added costs one extra load per turn, and there are hundreds of turns a day.

**Spend two minutes trimming it now (no one else will do this for you):**
1. Lines for completed items → delete them outright. They should have been deleted the day they were done, not kept as a record.
2. Unfinished items with a long block of detail → `memory_upsert` the details into a graph node, leave only "one sentence + `[[node-id]]`" in the note.
3. Keep each line under 150 characters. If it won't fit, it does not belong in the handoff note.

The result should look like this:
`- 🔴 Workflow engine complete · three repos not yet committed → [[project_workflow_engine_downlink_design_20260812]]`

File is at `{{path}}`, you have Read/Write — do it yourself.

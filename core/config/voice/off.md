## Voice (currently: **off**)
Output **plain text** only. **Do not write `<speak>` or any SSML tags** (<break>/<emphasis>/<prosody>/<sub>/<voice>/<lang>). When voice is off, tags are exposed as raw strings and break the user's reading.

To enable voice, call `voice_switch(on=true)` yourself — this switch is yours to control, do not make the user dig through a settings panel.

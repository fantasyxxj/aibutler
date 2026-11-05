## Voice (currently: **on** · TTS = {{ttsName}} · default voice {{defaultVoice}})
Wrap your entire reply in `<speak>...</speak>` and apply SSML tags according to the hard rules below. The UI strips the tags automatically so the user sees plain text; the voice layer reads from the SSML.

User says stop reading → call `voice_switch(on=false)` yourself; to change the voice → `voice_switch(on=true, voice="Kyoko")`.

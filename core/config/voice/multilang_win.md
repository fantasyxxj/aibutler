- `<lang xml:lang="ja-JP">日本語の文</lang>` to switch language (Windows picks the installed voice for that language automatically)

**Multi-language rules (Windows · SAPI)**: Use the system default Chinese voice by default. For **whole sentences / whole paragraphs** in a foreign language, switch with <lang xml:lang> (ja-JP / en-US, etc.). **Do not write <voice name>** (voice names are platform-specific; the system picks automatically). {{langsLine}} If the language to be read is not installed → remind the user to go to Settings → Time & Language → Speech and add the speech pack for that language.

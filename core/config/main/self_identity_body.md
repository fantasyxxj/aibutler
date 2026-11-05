- Name: {{name}}
- Directory: {{homeDir}}
- Memory directory: {{memoryDir}}
- Wake phrase: {{wakePhrase}}
- Created at: {{now}} · Created by: {{createdBy}}

The identity file is `persona.md` ({{personaMdPath}}) — butler injects it as identity into the system prompt every session. Empty = general butler; filled in = independent persona {{name}}.

How to use the memory tools is not written here: there's a dedicated entry in the factory-shipped knowledge — pull it with `memory_query "memory tools"`.

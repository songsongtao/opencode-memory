# supereasy-memory

Persistent memory plugin for OpenCode, ported from the excellent [pi-memory](https://pi.dev/packages/@samfp/pi-memory?name=memory).

This extension gives your AI assistant the ability to remember your preferences, project patterns, and corrections across sessions.

[中文文档](./README.zh-CN.md)

## Features

- **Persistent Storage** — Uses SQLite to store memories, ensuring they persist across different OpenCode sessions.
- **5 Built-in Tools** — The AI can search, store, and delete memories automatically or on command.
- **Auto-Injection** — Automatically injects relevant memories into the context at the start of every new session.
- **Smart Categorization** — Memories are grouped into preferences (`pref.*`), environment (`env.*`), tools (`tool.*`), and user (`user.*`).
- **Project Scoping** — Any preference can be global (applies everywhere) or scoped exclusively to the current project.
- **Intelligent Project Detection** — Uses git remote URLs to identify projects, automatically sharing memory across multiple clones of the same repository.
- **Lessons Learned** — Manages corrections and lessons separately, using Jaccard similarity deduplication to prevent redundant rules.
- **Full-Text Search** — Powered by FTS5 full-text search (with graceful fallback to fuzzy matching).

## Installation

This plugin is available on npm and does not require a separate Bun installation (OpenCode has Bun built-in).

1. Install the package:
```bash
npm install -g supereasy-memory
```

2. Open your `opencode.json` configuration file and add the package name to the `plugin` array:
```json
{
  "plugin": [
    "supereasy-memory"
  ]
}
```

3. Restart or reload OpenCode (`Ctrl/Cmd + R`) for the changes to take effect.

## Available Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Search semantic memory by keyword. |
| `memory_remember` | Store a fact or lesson (supports `scope` for global vs. project). |
| `memory_forget` | Delete a specific memory (supports scope deletion). |
| `memory_stats` | View memory statistics and scope distribution. |

## Usage Examples

### Storing Preferences
Tell the AI:
- *"Remember: I prefer conventional commits."* (AI defaults to global scope)
- *"Remember to use Next.js App Router for this project."* (AI defaults to project scope)

### Storing Lessons
- *"Remember the lesson: don't use `echo >>` for writing notes, use `sed` instead."*
- *"Remember: always show me a preview before deploying."*

### Searching & Managing Memory
- *"Search for my preferences regarding git."*
- *"What lessons have I recorded about deployment?"*
- *"Show memory stats."*
- *"Forget pref.commit_style."*

## Project Scope Rules

Every memory fact has a scope:

| Scope | Description | Use Cases |
|-------|-------------|-----------|
| **Global** | Visible across all projects | Language preferences, general coding style |
| **Project** | Visible only in the current project | Project framework, specific toolchains |

**Project Identification Strategy:**
1. Prioritizes `git remote get-url origin` (this allows different clones of the same repo to share memory).
2. Falls back to the full directory path if git is not available.

*Note: If the same key exists in both Global and Project scopes, the Project scope takes precedence.*

## Data Storage

Database is located at: `<plugin_dir>/data/memory.db`

Uses SQLite in WAL mode to support concurrent reads.

## License

This project is licensed under the [MIT License](LICENSE).

## Acknowledgements

This plugin is a port of [samfoy/pi-memory](https://pi.dev/packages/@samfp/pi-memory?name=memory). Special thanks to the original author for the incredible design and logic.



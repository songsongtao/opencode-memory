# OpenCode Memory - Agent Guidelines

## 🤖 Context for AI Agents
You are working on the `supereasy-memory` plugin, a persistent memory extension for OpenCode AI. This file provides you with the critical context needed to understand, modify, and deploy this codebase correctly.

## ⚠️ MANDATORY RULE: Documentation Sync
**ANY TIME you modify the logic, tools, or behavior of this plugin, you MUST simultaneously update `README.md` and `README.en.md`!**

Never leave the documentation out of sync with the implementation.

---

## 🛠️ Project Structure & Architecture

This is a Bun-based TypeScript project. 
The database uses `bun:sqlite` with local SQLite storage.

### Core Files
- `index.ts`: The main plugin entry point. It exports the `Plugin` function containing all the Tool definitions (`memory_remember`, `memory_search`, etc.) and the OpenCode lifecycle hooks (`experimental.chat.messages.transform` and `experimental.session.compacting`).
- `store.ts`: The SQLite data access layer. It handles migrations, FTS5 full-text search, and the Jaccard similarity algorithm for deduplicating lessons.
- `injector.ts`: The context injection layer. It reads memories from the store and formats them into an 8KB-limited XML block (`<persistent_memory>`) with dynamic grouping based on key prefixes.
- `test.ts`: The primary test suite.
- `package.json`: Contains the project metadata. No external runtime dependencies are allowed.

---

## 💻 How to Modify the Project

1. **Keep it Dependency-Free**: Do not add runtime NPM dependencies unless absolutely necessary. Rely on Bun's built-in modules (`bun:sqlite`, `node:path`, etc.).
2. **Database Schema Changes**: If you modify the SQLite schema in `store.ts`, remember that SQLite in Bun handles synchronous execution. Be careful with migrations as `bun:sqlite` does not support complex async migration flows out of the box.
3. **Context Injection Safety**: 
   - If you modify `injector.ts`, ensure that the output XML strictly adheres to the `MAX_CONTEXT_CHARS` (8000) limit. Failing to do so will cause the LLM context window to overflow and break the user's OpenCode session.
   - The injection in `experimental.chat.messages.transform` must only apply to the main agent. It automatically identifies subagents by checking if the session has a `parentID` via the OpenCode SDK, and skips memory injection for them to keep their context pure.
4. **Testing**: 
   - After making changes, ALWAYS run the test suite: `bun test test.ts`.
   - Ensure you haven't broken the FTS5 search or Jaccard similarity threshold tests.

---

## 🚀 How to Deploy / Run

The user develops in this directory (`e:\project\openc`), but the plugin is distributed via NPM (`supereasy-memory`).

1. **Local Live Testing**:
   For local development, the user can configure `~/.config/opencode/opencode.json` to include `"E:/project/openc"` in the `plugin` array. Code changes will be live upon pressing `Ctrl/Cmd + R` in OpenCode.
2. **NPM Deployment**:
   - The plugin is published to the NPM registry.
   - When a stable version is ready, update the version number in `package.json` and run `npm publish`.
   - The user then configures OpenCode to load it via `"supereasy-memory@latest"` or a specific version.

---

## 🧠 Using the Plugin (from the AI's perspective)
When the user installs this plugin, they gain 5 tools:
- `memory_remember`: Upserts facts or records lessons.
- `memory_search`: Full-text search across facts and lessons.
- `memory_stats`: Retrieves DB metrics.
- `memory_forget`: Deletes specific keys or lesson IDs.

If the user gives you an instruction like "Remember that I prefer TypeScript," you should proactively invoke the `memory_remember` tool. **You do not need to ask for permission to remember things if the user explicitly commanded you to do so.**


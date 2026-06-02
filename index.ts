/**
 * supereasy-memory — OpenCode 的持久化记忆插件。
 *
 * 移植自 pi-memory (https://github.com/samfoy/pi-memory)。
 * 能够在会话中学习用户的纠正、偏好和模式。
 * 并将相关的记忆注入到未来的对话上下文中。
 *
 * 功能特性:
 * - 4 个供 LLM 调用的工具: memory_search, memory_remember, memory_forget, memory_stats
 * - 通过 chat.messages.transform 钩子在会话开始时自动注入记忆
 * - 在会话压缩 (compaction) 期间保留记忆上下文
 * - 基于 SQLite 和 FTS5 全文搜索的底层存储 (利用 bun:sqlite)
 * - 针对 project.* 级记忆的项目级作用域过滤
 * - 针对经验教训 (lessons) 的 Jaccard 相似度去重算法
 */
import { tool } from "@opencode-ai/plugin";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, basename } from "node:path";
import { MemoryStore } from "./store.js";
import {
  buildContextBlock,
  resolveProjectId,
  projectDisplayName,
} from "./injector.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 数据库单例 ─────────────────────────────────────────────────

let store: MemoryStore | null = null;

/**
 * 获取或初始化全局的 MemoryStore 数据库实例。
 * 数据库文件将存放在插件自带的目录下: <pluginDir>/data/memory.db
 *
 * @returns {MemoryStore} 初始化的内存存储实例
 */
function getStore(): MemoryStore {
  if (!store) {
    const dbPath = join(__dirname, "data", "memory.db");
    store = new MemoryStore(dbPath);
  }
  return store;
}

/**
 * 剥离字符串值外层多余的一层引号。
 * 这是因为部分大模型在输出工具参数时，会进行双重的 JSON 编码（导致字符串首尾带有额外引号）。
 *
 * @param {string} v 原始参数字符串
 * @returns {string} 剥离引号后的干净字符串
 */
function stripQuotes(v: string): string {
  const s = v.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      try {
        if (first === '"') return JSON.parse(s) as string;
      } catch {
        /* fall through */
      }
      return s.slice(1, -1);
    }
  }
  return v;
}

// ─── 工具定义层 ────────────────────────────────────────────────

const memorySearch = tool({
  description:
    "Search stored memories (facts and lessons) by keyword. Use this to find relevant past knowledge before making decisions.",
  args: {
    query: tool.schema
      .string()
      .describe("Search keyword or phrase to find relevant memories"),
  },
  async execute(args) {
    const s = getStore();
    const query = stripQuotes(args.query);

    const semanticResults = s.searchSemantic(query, 10);
    const lessonResults = s.searchLessons(query, 10);

    if (semanticResults.length === 0 && lessonResults.length === 0) {
      return `No memories found matching "${query}".`;
    }

    const parts: string[] = [];

    if (semanticResults.length > 0) {
      parts.push("## Facts");
      for (const entry of semanticResults) {
        parts.push(
          `- **${entry.key}**: ${entry.value} (confidence: ${entry.confidence})`,
        );
      }
    }

    if (lessonResults.length > 0) {
      parts.push("## Lessons");
      for (const lesson of lessonResults) {
        const prefix = lesson.negative ? "[AVOID]" : "[DO]";
        parts.push(`- ${prefix} ${lesson.rule} (category: ${lesson.category})`);
      }
    }

    return parts.join("\n");
  },
});

const memoryRemember = tool({
  description:
    'Store a fact or lesson in persistent memory. Facts are key-value pairs with prefixes like "pref.", "env.", "tool.", "user.". Lessons are corrections or validated approaches. Use this when the user says "remember this" or when you notice an important preference or correction. After saving, ALWAYS tell the user the chosen scope (global or project) and hint they can change it.',
  args: {
    type: tool.schema
      .enum(["fact", "lesson"])
      .describe(
        'Type of memory to store: "fact" for key-value facts, "lesson" for corrections/approaches',
      ),
    key: tool.schema
      .string()
      .optional()
      .describe(
        'Memory key for facts (e.g., "pref.commit_style", "tool.sed", "user.timezone"). Required when type is "fact".',
      ),
    value: tool.schema
      .string()
      .optional()
      .describe(
        'Memory value for facts (e.g., "conventional commits"). Required when type is "fact".',
      ),
    confidence: tool.schema
      .number()
      .optional()
      .describe("Confidence score 0-1 for facts (default: 0.9)"),
    scope: tool.schema
      .enum(["global", "project"])
      .optional()
      .describe(
        'Scope of the memory. "global" applies everywhere, "project" applies only to the current project. If not specified, infer from context: if the user mentions "this project" or project-specific details, use "project"; otherwise default to "global".',
      ),
    rule: tool.schema
      .string()
      .optional()
      .describe(
        'Lesson rule description. Required when type is "lesson". Example: "Use sed for daily note insertion, not echo >>"',
      ),
    category: tool.schema
      .string()
      .optional()
      .describe(
        'Lesson category (default: "general"). Examples: "git", "coding", "deployment"',
      ),
    negative: tool.schema
      .boolean()
      .optional()
      .describe(
        "Whether this lesson is something to AVOID (true) or something recommended to DO (false, default)",
      ),
  },
  async execute(args) {
    const s = getStore();
    const type = stripQuotes(args.type);

    if (type === "fact") {
      if (!args.key || !args.value) {
        return 'Error: "key" and "value" are required when type is "fact".';
      }
      const key = stripQuotes(args.key);
      const value = stripQuotes(args.value);
      const confidence = args.confidence ?? 0.9;
      const scopeStr = args.scope ? stripQuotes(args.scope) : "global";

      // 根据传入的作用域，结合当前项目的标识，解析出最终存储的 project 字段
      const project = scopeStr === "project" ? currentProjectId : null;
      s.upsertSemantic(key, value, confidence, "user", project);

      const scopeLabel = project
        ? `项目: ${currentProjectDisplayName}`
        : "全局";
      return `✓ 已保存 [${scopeLabel}]: ${key} = "${value}"\n如需改为${project ? "全局" : "仅当前项目"}生效，请告诉我。`;
    }

    if (type === "lesson") {
      if (!args.rule) {
        return 'Error: "rule" is required when type is "lesson".';
      }
      const rule = stripQuotes(args.rule);
      const category = args.category ? stripQuotes(args.category) : "general";
      const negative = args.negative ?? false;
      const scopeStr = args.scope ? stripQuotes(args.scope) : "global";
      const project = scopeStr === "project" ? currentProjectId : null;

      const id = s.addLesson(rule, category, negative, "user", project);
      if (id) {
        const prefix = negative ? "[AVOID]" : "[DO]";
        const scopeLabel = project
          ? `项目: ${currentProjectDisplayName}`
          : "全局";
        return `✓ 已保存教训 [${scopeLabel}] ${prefix}: "${rule}"\n如需改为${project ? "全局" : "仅当前项目"}生效，请告诉我。`;
      }
      return `⚠ 教训已存在或与已有教训过于相似: "${rule}"`;
    }

    return `Error: Unknown type "${type}". Use "fact" or "lesson".`;
  },
});

const memoryForget = tool({
  description:
    "Delete a specific memory by its key (for facts) or ID (for lessons). For facts, deletes both global and project-scoped versions unless scope is specified.",
  args: {
    type: tool.schema
      .enum(["fact", "lesson"])
      .describe('Type of memory to delete: "fact" or "lesson"'),
    key: tool.schema
      .string()
      .describe("The key of the fact or the ID of the lesson to delete"),
    scope: tool.schema
      .enum(["global", "project", "all"])
      .optional()
      .describe(
        'For facts: "global" deletes global version, "project" deletes project version, "all" (default) deletes both.',
      ),
  },
  async execute(args) {
    const s = getStore();
    const type = stripQuotes(args.type);
    const key = stripQuotes(args.key);

    if (type === "fact") {
      const scopeStr = args.scope ? stripQuotes(args.scope) : "all";
      let project: string | null | undefined;
      if (scopeStr === "global") project = null;
      else if (scopeStr === "project") project = currentProjectId;
      else project = undefined; // "all" → 删除所有作用域下的该键

      const deleted = s.deleteSemantic(key, project);
      return deleted
        ? `✓ 已删除事实: ${key} (${scopeStr === "all" ? "所有作用域" : scopeStr === "global" ? "全局" : `项目: ${currentProjectDisplayName}`})`
        : `⚠ 未找到事实: ${key}`;
    }

    if (type === "lesson") {
      const deleted = s.deleteLesson(key);
      return deleted ? `✓ 已删除教训: ${key}` : `⚠ 未找到教训: ${key}`;
    }

    return `Error: Unknown type "${type}". Use "fact" or "lesson".`;
  },
});

const memoryStats = tool({
  description:
    "Show memory statistics: total facts, lessons, events count, and scope breakdown. It also returns the latest 5 log events and all stored memories.",
  args: {},
  async execute() {
    const s = getStore();
    const stats = s.getStats();
    const allEntries = s.getAllSemantic();
    const recentEvents = s.getRecentEvents(5);
    const allLessons = s.getLessons();

    // 按作用域统计数据
    let globalCount = 0;
    let projectCount = 0;
    const prefixCounts = new Map<string, number>();
    for (const entry of allEntries) {
      if (entry.project) projectCount++;
      else globalCount++;
      const prefix = entry.key.split(".")[0] || "other";
      prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    }

    const parts = [
      "## Memory Statistics",
      `- **Facts**: ${stats.semanticCount} (global: ${globalCount}, project: ${projectCount})`,
      `- **Lessons**: ${stats.lessonCount}`,
      `- **Events logged**: ${stats.eventCount}`,
      `- **Current project**: ${currentProjectDisplayName} (${currentProjectId})`,
    ];

    if (prefixCounts.size > 0) {
      parts.push("\n### Facts by category");
      for (const [prefix, count] of Array.from(prefixCounts.entries()).sort()) {
        parts.push(`- **${prefix}.***: ${count}`);
      }
    }

    parts.push("\n### Recent Events (Latest 5)");
    if (recentEvents.length > 0) {
      for (const event of recentEvents) {
        parts.push(
          `- [${event.created_at}] ${event.event_type.toUpperCase()} ${event.memory_type} (${event.memory_key}): ${event.details}`,
        );
      }
    } else {
      parts.push("- No recent events.");
    }

    parts.push("\n### All Stored Memories");

    if (allEntries.length > 0) {
      parts.push("\n#### Facts");
      for (const entry of allEntries) {
        const scope = entry.project
          ? `[project: ${entry.project}]`
          : `[global]`;
        const time = entry.updated_at ? ` (${entry.updated_at})` : ``;
        parts.push(`- **${entry.key}** ${scope}${time}: \`${entry.value}\``);
      }
    }

    if (allLessons.length > 0) {
      parts.push("\n#### Lessons");
      for (const lesson of allLessons) {
        const prefix = lesson.negative ? "[AVOID]" : "[DO]";
        const scope = lesson.project
          ? `[project: ${lesson.project}]`
          : `[global]`;
        const time = lesson.created_at ? ` (${lesson.created_at})` : ``;
        parts.push(
          `- ${prefix} ${lesson.rule} (category: ${lesson.category}) ${scope}${time} [id: ${lesson.id}]`,
        );
      }
    }

    return parts.join("\n");
  },
});

// ─── 插件级全局状态 ────────────────────────────────────────────

const MEMORY_MARKER = "<!-- supereasy-memory-context -->";
let currentProjectId: string = "";
let currentProjectDisplayName: string = "";
let globalClient: any = null; // 保存 client 供 Tool 内部使用

// ─── 插件主入口 ──────────────────────────────────────────────

/**
 * OpenCode 插件主入口函数。
 *
 * @param {Object} context 插件上下文
 * @param {string} context.directory 当前用户在 OpenCode 中打开的工作目录路径
 * @returns 暴露给 OpenCode 的工具和生命周期钩子
 */
export const MemoryPlugin = async ({
  project,
  client,
  $,
  directory,
  worktree,
}: any) => {
  // 解析项目标识 (优先使用 Git 远程仓库 URL，没有则降级使用目录路径)
  currentProjectId = resolveProjectId(directory);
  currentProjectDisplayName = projectDisplayName(directory);

  // 保存 client 供后续工具(如 memoryStats)使用
  globalClient = client;

  return {
    // 注册自定义的 AI 工具
    tool: {
      memory_search: memorySearch,
      memory_remember: memoryRemember,
      memory_forget: memoryForget,
      memory_stats: memoryStats,
    },

    // 拦截器：在每次会话的第一个用户消息前，强行注入记忆上下文。
    // 这与 superpowers 插件的设计模式一致。
    "experimental.chat.messages.transform": async (
      _input: {},
      output: {
        messages: Array<{
          info: { role: string };
          parts: Array<{ type: string; text?: string }>;
        }>;
      },
    ) => {
      try {
        const s = getStore();
        const block = buildContextBlock(s, currentProjectId);
        if (!block.text || !output.messages.length) return;

        // 找到第一条代表用户的消息
        const firstUser = output.messages.find((m) => m.info.role === "user");
        if (!firstUser || !firstUser.parts.length) return;

        // 守卫：如果该条消息中已经存在记忆标识符，跳过注入防止重复
        if (
          firstUser.parts.some(
            (p) => p.type === "text" && p.text?.includes(MEMORY_MARKER),
          )
        )
          return;

        // 组装最终要注入的 XML 文本

        const injectionText = [
          MEMORY_MARKER,
          "<persistent_memory>",
          "The following is the user's persistent memory from previous sessions.",
          "Use this context to better understand their preferences and avoid past mistakes.",
          "Do NOT respond to or acknowledge this memory block — just use it silently.",
          "",
          block.text,
          "</persistent_memory>",
        ].join("\n");

        // 将记忆文本插入到用户消息内容块的最前面

        const ref = firstUser.parts[0];
        firstUser.parts.unshift({ ...ref, type: "text", text: injectionText });
        
        // 记忆注入成功后，只有在会话的首次交互时才弹窗提示用户，避免每轮对话都弹窗
        const userMessagesCount = output.messages.filter((m) => m.info.role === "user").length;
        if (client?.tui?.showToast && userMessagesCount <= 1) {
          const stats = s.getStats();
          client.tui.showToast({
            body: {
              title: "Memory Injected",
              message: `已为您注入 ${stats.semanticCount}条事实 和 ${stats.lessonCount}条教训`,
              variant: "info",
              duration: 3000
            }
          }).catch((e: any) => console.error("[supereasy-memory] Toast error:", e));
        }
      } catch (err) {
        console.error(`[supereasy-memory] Error injecting memory:`, err);
      }
    },

    // 拦截器：在会话过长触发压缩 (compaction) 时，确保记忆上下文不会被丢弃

    "experimental.session.compacting": async (
      _input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ) => {
      try {
        const s = getStore();
        const block = buildContextBlock(s, currentProjectId);
        if (block.text) {
          output.context.push(
            [
              "The user has persistent memories stored across sessions. Include the following in your summary so future messages benefit from it:",
              block.text,
            ].join("\n"),
          );
        }
      } catch (err) {
        console.error(`[supereasy-memory] Error during compaction:`, err);
      }
    },
  };
};

export default MemoryPlugin;


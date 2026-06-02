/**
 * 记忆注入器 (Memory Injector) — 负责从存储的记忆中构建出 XML 格式的上下文块。
 *
 * 移植自 pi-memory (https://github.com/samfoy/pi-memory)。
 *
 * 该模块会根据键名前缀将记忆分类成不同的区块：
 * - 偏好设置 (pref.*)
 * - 工具偏好 (tool.*)
 * - 用户身份 (user.*)
 * - 环境、通用等 (动态分组)
 * - 经验教训 (lessons) — 纠错记录和经过验证的方法
 *
 * 项目作用域 (Project scoping): 事实记忆支持使用 `project` 字段（Git 远程仓库 URL 或本地路径）进行隔离。
 * 注入时会同时包含 全局记忆 (project=NULL) + 当前项目记忆。
 * 如果出现相同的键名，当前项目级的记忆会覆盖全局级的记忆。
 *
 * 最终输出的格式为 XML，并且限制最大长度不超过 8KB，以防挤爆大模型的上下文窗口。
 */
import type { MemoryStore, SemanticEntry, LessonEntry } from "./store.js";
import { basename } from "node:path";

/** 上下文块允许的最大字符数，防止过长截断系统提示词 */
const MAX_CONTEXT_CHARS = 8000;

/**
 * 注入器返回的上下文块数据结构
 */
export interface ContextBlock {
  /** 格式化好的 XML 文本 */
  text: string;
  /** 统计数据 */
  stats: {
    /** 包含的事实记忆条数 */
    semantic: number;
    /** 包含的经验教训条数 */
    lessons: number;
  };
}

/**
 * 从当前工作目录解析出当前项目的唯一标识符。
 * 优先级 1: Git 远程仓库的 URL (会自动剥离 http 协议前缀和 .git 后缀)
 * 优先级 2: 标准化后的绝对路径 (转为小写并使用正斜杠)
 *
 * 使用 Git 远程 URL 作为标识的好处在于：同一个仓库无论被 clone 到哪台电脑或哪个目录下，
 * 都会自动共享该项目作用域下的所有记忆。
 * 
 * @param cwd 当前工作目录的绝对路径
 * @returns 项目的唯一标识字符串
 */
export function resolveProjectId(cwd: string): string {
  try {
    const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const url = proc.stdout.toString().trim();
    if (url) {
      // 转换格式示例：
      // "https://github.com/user/repo.git" → "github.com/user/repo"
      // "git@github.com:user/repo.git" → "github.com/user/repo"
      return url
        .replace(/^https?:\/\//, "")
        .replace(/^git@/, "")
        .replace(/:/g, "/")
        .replace(/\.git$/, "")
        .toLowerCase();
    }
  } catch {
    // git 命令不可用或者当前目录不是一个 git 仓库
  }
  // 降级方案: 使用标准化的绝对路径
  return cwd.replace(/\\/g, "/").toLowerCase();
}

/**
 * 从目录路径中提取出适合展示的项目名称。
 * 通常只提取最后一段目录名，用于给用户展示友好的提示信息。
 * 
 * @param cwd 当前工作目录的绝对路径
 * @returns 友好的项目名称
 */
export function projectDisplayName(cwd: string): string {
  return basename(cwd);
}

/**
 * 构建完整的记忆上下文块，用于在系统提示词前进行被动注入。
 *
 * 当传入了 `projectId` 时，存储层会返回 全局记忆 + 该项目的局部记忆
 * (遇到键名冲突时，项目级记忆会覆盖全局级记忆)。
 * 
 * @param store MemoryStore 数据库存储实例
 * @param projectId 当前项目的唯一标识（可选）
 * @returns 构建好的包含 XML 和统计信息的 ContextBlock 对象
 */
export function buildContextBlock(
  store: MemoryStore,
  projectId?: string
): ContextBlock {
  const allEntries = store.getAllSemantic(projectId || null);
  const allLessons = store.getLessons();

  if (allEntries.length === 0 && allLessons.length === 0) {
    return { text: "", stats: { semantic: 0, lessons: 0 } };
  }

  // 过滤出属于全局或当前项目的经验教训
  const lessons = allLessons.filter(
    (l) => !l.project || !projectId || l.project === projectId
  );

  // ── 通过键名的第一个小数点进行动态分组 ──────────────
  const groupMap = new Map<string, SemanticEntry[]>();

  /** 针对一些众所周知的前缀提供语义化更友好的分组标签名 */
  const groupNames: Record<string, string> = {
    pref: "preferences",
    project: "project_context",
    tool: "tool_preferences",
    user: "user_identity",
  };

  for (const entry of allEntries) {
    const dotIdx = entry.key.indexOf(".");
    const rawPrefix = dotIdx > 0 ? entry.key.slice(0, dotIdx) : "general";
    const groupKey = groupNames[rawPrefix] || rawPrefix;
    let arr = groupMap.get(groupKey);
    if (!arr) {
      arr = [];
      groupMap.set(groupKey, arr);
    }
    arr.push(entry);
  }

  /**
   * 将键名人性化以便于大模型阅读：剥离已知的前缀，并将下划线和点替换为空格。
   * 例如: "pref.commit_style" → "commit style"
   * 例如: "coding_guidelines" → "coding guidelines"
   * 
   * @param key 原始记忆键名
   * @returns 人性化后的字符串
   */
  const humanizeKey = (key: string): string => {
    const dotIdx = key.indexOf(".");
    const stripped = dotIdx > 0 ? key.slice(dotIdx + 1) : key;
    return stripped.replace(/[._]/g, " ").trim();
  };

  // 开始组装最终的 XML 区块数组
  const sections: string[] = [];
  let totalChars = 0;
  let semanticCount = 0;

  /**
   * 内部辅助函数：格式化并将一个分组添加到 XML 结果中，同时进行严格的长度截断检查
   * 
   * @param tag XML 的标签名
   * @param entries 该标签下包含的事实记忆数组
   */
  const addSection = (
    tag: string,
    entries: SemanticEntry[],
  ): void => {
    if (entries.length === 0) return;
    const lines = entries.map((e) => `    - ${humanizeKey(e.key)}: ${e.value}`);
    const section = `  <${tag}>\n${lines.join("\n")}\n  </${tag}>`;
    if (totalChars + section.length <= MAX_CONTEXT_CHARS) {
      sections.push(section);
      totalChars += section.length;
      semanticCount += entries.length;
    }
  };

  // 优先级顺序：保证这些重要的内置分组优先被注入 XML，以免被长度截断
  const priorityOrder = ["preferences", "project_context", "tool_preferences", "user_identity"];
  for (const key of priorityOrder) {
    const entries = groupMap.get(key);
    if (entries) {
      addSection(key, entries);
      groupMap.delete(key);
    }
  }

  // 经验教训区块 (特殊格式，优先排在重要的事实记忆之后)
  if (lessons.length > 0) {
    const lessonLines = lessons.map((l) => {
      const prefix = l.negative ? "[AVOID]" : "[DO]";
      return `    ${prefix} ${l.rule}`;
    });
    const lessonSection = `  <lessons>\n${lessonLines.join("\n")}\n  </lessons>`;
    if (totalChars + lessonSection.length <= MAX_CONTEXT_CHARS) {
      sections.push(lessonSection);
      totalChars += lessonSection.length;
    }
  }

  // 剩余的其他动态分组按首字母升序排序后依次注入
  for (const [key, entries] of Array.from(groupMap.entries()).sort()) {
    addSection(key, entries);
  }

  if (sections.length === 0) {
    return { text: "", stats: { semantic: 0, lessons: 0 } };
  }

  const text = `<memory>\n${sections.join("\n")}\n</memory>`;
  return {
    text,
    stats: { semantic: semanticCount, lessons: lessons.length },
  };
}

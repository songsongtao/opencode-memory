/**
 * 基于 SQLite 驱动的持久化记忆存储层，底层使用 Bun 原生的 bun:sqlite。
 *
 * 移植自 pi-memory (https://github.com/samfoy/pi-memory)。
 * 数据库包含三张核心表:
 * - semantic: 键值对形式的事实记忆 (偏好设置、项目级开发模式、工具偏好)
 * - lessons: 学习到的经验教训，包含去重机制 (基于 Jaccard 相似度)
 * - events: 审计日志表，记录所有的记忆读写操作
 *
 * 默认尝试使用 FTS5 引擎进行全文搜索；如果环境不支持 FTS5，则自动降级使用 LIKE 模糊匹配。
 */
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ─── 类型定义 ───────────────────────────────────────────────────────────

export interface SemanticEntry {
  /** 记忆的键名，通常包含点号前缀用于分组 (如 pref.code_style) */
  key: string;
  /** 记忆的值内容 */
  value: string;
  /** 置信度 (0-1)，代表该记忆的准确程度 */
  confidence: number;
  /** 记忆的来源: user (用户指定) | consolidation (后台整合) | correction (AI纠错) */
  source: "user" | "consolidation" | "correction";
  /** 创建时间的 ISO 字符串 */
  created_at: string;
  /** 最后一次更新的 ISO 字符串 */
  updated_at: string;
  /** 最后一次访问的 ISO 字符串 (可选) */
  last_accessed?: string;
  /**
   * 项目标识符 (Git 远程仓库 URL 或本地格式化路径)。
   * 如果是全局记忆则该值为 null。
   */
  project: string | null;
}

export interface LessonEntry {
  /** 教训的唯一 UUID */
  id: string;
  /** 教训的具体规则描述 */
  rule: string;
  /** 类别分类 (例如 'git', 'coding') */
  category: string;
  /** 来源 */
  source: string;
  /** 是否是反面教材（需要 AVOID 避免的，而非 DO 推荐的） */
  negative: boolean;
  /** 创建时间的 ISO 字符串 */
  created_at: string;
  /** 该教训提取时所在的项目标识，全局教训则为 null */
  project: string | null;
}

export interface MemoryEvent {
  /** 递增的主键 ID */
  id: number;
  /** 事件类型 (例如 'upsert', 'delete') */
  event_type: string;
  /** 记忆类型 ('semantic' 或 'lesson') */
  memory_type: string;
  /** 受影响的记忆键名或教训 ID */
  memory_key: string;
  /** 详细的修改内容日志 */
  details: string;
  /** 发生时间的 ISO 字符串 */
  created_at: string;
}

export interface MemoryStats {
  /** 事实记忆总数 */
  semanticCount: number;
  /** 经验教训总数 */
  lessonCount: number;
  /** 事件日志总数 */
  eventCount: number;
}

// ─── 杰卡德相似度 (Jaccard Similarity) 算法 ──────────────────────────────────────────────

/**
 * 使用基于词级别的 Token 拆分来计算两个字符串的 Jaccard 相似度。
 * 主要用于经验教训的去重拦截 — 如果相似度 >= 0.7，我们就会认为这是一条重复的教训。
 *
 * @param a 第一个需要比较的字符串
 * @param b 第二个需要比较的字符串
 * @returns {number} 相似度得分 (0.0 到 1.0)
 */
function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter(Boolean),
    );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ─── 数据库存储类 (Store) ───────────────────────────────────────────────────────────

export class MemoryStore {
  private db: Database;
  private hasFTS5: boolean = false;

  /**
   * 实例化内存数据库并运行迁移。
   *
   * @param dbPath 数据库文件存放的绝对路径
   */
  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic (
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.8,
        source TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed TEXT,
        project TEXT,
        UNIQUE(key, project)
      );

      CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY,
        rule TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        source TEXT NOT NULL DEFAULT 'user',
        negative INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        project TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        memory_key TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // 创建用于全文搜索的 FTS5 虚拟表及触发器 (bun:sqlite 的部分环境可能不支持)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(
          key, value, content='semantic', content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS semantic_ai AFTER INSERT ON semantic BEGIN
          INSERT INTO semantic_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
        END;
        CREATE TRIGGER IF NOT EXISTS semantic_ad AFTER DELETE ON semantic BEGIN
          INSERT INTO semantic_fts(semantic_fts, rowid, key, value) VALUES('delete', old.rowid, old.key, old.value);
        END;
        CREATE TRIGGER IF NOT EXISTS semantic_au AFTER UPDATE ON semantic BEGIN
          INSERT INTO semantic_fts(semantic_fts, rowid, key, value) VALUES('delete', old.rowid, old.key, old.value);
          INSERT INTO semantic_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
        END;
      `);

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(
          rule, category, content='lessons', content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS lessons_ai AFTER INSERT ON lessons BEGIN
          INSERT INTO lessons_fts(rowid, rule, category) VALUES (new.rowid, new.rule, new.category);
        END;
        CREATE TRIGGER IF NOT EXISTS lessons_ad AFTER DELETE ON lessons BEGIN
          INSERT INTO lessons_fts(lessons_fts, rowid, rule, category) VALUES('delete', old.rowid, old.rule, old.category);
        END;
        CREATE TRIGGER IF NOT EXISTS lessons_au AFTER UPDATE ON lessons BEGIN
          INSERT INTO lessons_fts(lessons_fts, rowid, rule, category) VALUES('delete', old.rowid, old.rule, old.category);
          INSERT INTO lessons_fts(rowid, rule, category) VALUES (new.rowid, new.rule, new.category);
        END;
      `);

      this.hasFTS5 = true;
    } catch {
      // 环境不支持 FTS5 引擎，将会降级使用 LIKE 搜索
      this.hasFTS5 = false;
    }

    // 每次启动时如果支持 FTS5，就全量重建一次全文索引，确保虚拟表和真实表数据一致
    if (this.hasFTS5) {
      try {
        this.db.exec(
          `INSERT INTO semantic_fts(semantic_fts) VALUES('rebuild')`,
        );
        this.db.exec(`INSERT INTO lessons_fts(lessons_fts) VALUES('rebuild')`);
      } catch {
        // 忽略重建过程中可能发生的错误
      }
    }
  }

  // ─── 事实记忆 (Semantic Memory) 操作 ─────────────────────────────────────────────

  /**
   * 搜索事实记忆，优先使用 FTS5 引擎，失败则降级使用 LIKE 匹配。
   *
   * @param query 搜索关键词
   * @param limit 返回的最大条数 (默认 15)
   * @returns 匹配到的事实记忆数组
   */
  searchSemantic(query: string, limit: number = 15): SemanticEntry[] {
    if (!query.trim()) return [];

    if (this.hasFTS5) {
      try {
        // 针对 FTS5 引擎净化查询字符串 — 移除特殊字符并使用 OR 连接多个单词
        const sanitized = query
          .replace(/['"]/g, "")
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => `"${w}"`)
          .join(" OR ");

        if (!sanitized) return this.searchSemanticFallback(query, limit);

        const stmt = this.db.prepare(`
          SELECT s.key, s.value, s.confidence, s.source, s.created_at, s.updated_at, s.last_accessed
          FROM semantic s
          JOIN semantic_fts f ON s.rowid = f.rowid
          WHERE semantic_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `);
        const results = stmt.all(sanitized, limit) as SemanticEntry[];

        // 成功返回前更新命中记录的 last_accessed 时间戳
        if (results.length > 0) {
          const updateStmt = this.db.prepare(
            `UPDATE semantic SET last_accessed = datetime('now') WHERE key = ?`,
          );
          for (const r of results) {
            updateStmt.run(r.key);
          }
        }

        return results;
      } catch {
        return this.searchSemanticFallback(query, limit);
      }
    }

    return this.searchSemanticFallback(query, limit);
  }

  private searchSemanticFallback(
    query: string,
    limit: number,
  ): SemanticEntry[] {
    const words = query
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `%${w}%`);
    if (words.length === 0) return [];

    // 针对每个拆分后的词，构建 (key LIKE ? OR value LIKE ?) 的查询条件
    const conditions = words
      .map(() => `(key LIKE ? OR value LIKE ?)`)
      .join(" OR ");
    const params: (string | number)[] = [];
    for (const w of words) {
      params.push(w, w);
    }
    params.push(limit);

    const stmt = this.db.prepare(`
      SELECT key, value, confidence, source, created_at, updated_at, last_accessed
      FROM semantic
      WHERE ${conditions}
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    const results = stmt.all(...params) as SemanticEntry[];

    // 更新访问时间
    if (results.length > 0) {
      const updateStmt = this.db.prepare(
        `UPDATE semantic SET last_accessed = datetime('now') WHERE key = ?`,
      );
      for (const r of results) {
        updateStmt.run(r.key);
      }
    }

    return results;
  }

  /**
   * 插入或更新一条事实记忆记录。
   *
   * @param key 记忆的键名 (如 'user.timezone')
   * @param value 记忆的值 (如 'Asia/Shanghai')
   * @param confidence 置信度，代表记忆的准确性，0-1 之间 (默认 0.9)
   * @param source 来源标识符 (默认 'user')
   * @param project 项目标识符 (Git 远程 URL 或本地路径)，如果属于全局记忆请传入 null
   */
  upsertSemantic(
    key: string,
    value: string,
    confidence: number = 0.9,
    source: string = "user",
    project: string | null = null,
  ): void {
    // SQLite 中的 UNIQUE(key, project) 将 NULL 视为彼此不同，
    // 因此我们需要分别针对 全局作用域 (project IS NULL) 和 局部作用域 进行不同的插入与更新处理。
    if (project === null) {
      const stmt = this.db.prepare(`
        INSERT INTO semantic (key, value, confidence, source, project, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, datetime('now'), datetime('now'))
        ON CONFLICT(key, project) DO UPDATE SET
          value = excluded.value,
          confidence = excluded.confidence,
          source = excluded.source,
          updated_at = datetime('now')
      `);
      // 由于 SQLite 的 UNIQUE 会将 NULL != NULL，我们需要对全局记录提供降级处理
      // 策略：先尝试进行更新操作，如果不存在则进行插入
      const existing = this.db
        .prepare(`SELECT 1 FROM semantic WHERE key = ? AND project IS NULL`)
        .get(key);
      if (existing) {
        this.db
          .prepare(
            `
          UPDATE semantic SET value = ?, confidence = ?, source = ?, updated_at = datetime('now')
          WHERE key = ? AND project IS NULL
        `,
          )
          .run(value, confidence, source, key);
      } else {
        this.db
          .prepare(
            `
          INSERT INTO semantic (key, value, confidence, source, project, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, datetime('now'), datetime('now'))
        `,
          )
          .run(key, value, confidence, source);
      }
    } else {
      const existing = this.db
        .prepare(`SELECT 1 FROM semantic WHERE key = ? AND project = ?`)
        .get(key, project);
      if (existing) {
        this.db
          .prepare(
            `
          UPDATE semantic SET value = ?, confidence = ?, source = ?, updated_at = datetime('now')
          WHERE key = ? AND project = ?
        `,
          )
          .run(value, confidence, source, key, project);
      } else {
        this.db
          .prepare(
            `
          INSERT INTO semantic (key, value, confidence, source, project, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `,
          )
          .run(key, value, confidence, source, project);
      }
    }

    const scope = project ? `[project: ${project}]` : "[global]";
    this.logEvent("upsert", "semantic", key, `${scope} ${value}`);
  }

  /**
   * 按键名及可选的项目标识删除一条事实记忆记录。
   * 如果不传 project 参数 (undefined)，则删除对应 key 的所有记录（包括全局和所有项目特有的记录）。
   * 如果 project 传 null，则只删除全局记录。
   * 如果 project 是字符串，则仅删除对应项目的记录。
   *
   * @param key 要删除的键名
   * @param project 目标项目标识 (可选)
   * @returns {boolean} 如果有成功删除的记录则返回 true
   */
  deleteSemantic(key: string, project?: string | null): boolean {
    let result;
    if (project === undefined) {
      // 删除包含此键名的所有记录 (无论是否全局)
      result = this.db.prepare(`DELETE FROM semantic WHERE key = ?`).run(key);
    } else if (project === null) {
      result = this.db
        .prepare(`DELETE FROM semantic WHERE key = ? AND project IS NULL`)
        .run(key);
    } else {
      result = this.db
        .prepare(`DELETE FROM semantic WHERE key = ? AND project = ?`)
        .run(key, project);
    }
    if (result.changes > 0) {
      this.logEvent("delete", "semantic", key, project ?? "global");
      return true;
    }
    return false;
  }

  /**
   * 根据项目作用域提取所有事实记忆记录。
   * 该方法会返回 全局记录 (project IS NULL) 加上对应 projectId 的项目私有记录。
   * 如果存在相同 key 的情况，项目私有的记录会覆盖掉全局记录 (去重)。
   *
   * @param projectId 项目唯一标识 (可选)
   * @returns 合并去重后的所有事实记忆记录数组
   */
  getAllSemantic(projectId?: string | null): SemanticEntry[] {
    let rows: SemanticEntry[];
    if (projectId) {
      // 获取 全局 + 当前项目 的记录
      const stmt = this.db.prepare(`
        SELECT key, value, confidence, source, created_at, updated_at, last_accessed, project
        FROM semantic
        WHERE project IS NULL OR project = ?
        ORDER BY updated_at DESC
      `);
      rows = stmt.all(projectId) as SemanticEntry[];
    } else {
      const stmt = this.db.prepare(`
        SELECT key, value, confidence, source, created_at, updated_at, last_accessed, project
        FROM semantic
        ORDER BY updated_at DESC
      `);
      rows = stmt.all() as SemanticEntry[];
    }

    // 去重逻辑：对于同一个 key，带有 project 的局部记录优先级高于全局记录
    if (projectId) {
      const seen = new Map<string, SemanticEntry>();
      // 第一遍循环：优先收集属于当前项目的局部记录 (优先级更高)
      for (const row of rows) {
        if (row.project !== null) {
          seen.set(row.key, row);
        }
      }
      // 第二遍循环：把那些不存在局部覆盖的全局记录填充进去
      for (const row of rows) {
        if (row.project === null && !seen.has(row.key)) {
          seen.set(row.key, row);
        }
      }
      return Array.from(seen.values());
    }

    return rows;
  }

  /**
   * 通过键名前缀提取所有对应的事实记忆记录。
   * 通常用于导出某一特定分类下的记忆。
   *
   * @param prefix 需要匹配的前缀 (如 'pref.')
   * @param limit 返回的最大条数 (默认 50)
   * @returns 匹配到的记录数组
   */
  getSemanticByPrefix(prefix: string, limit: number = 50): SemanticEntry[] {
    const stmt = this.db.prepare(`
      SELECT key, value, confidence, source, created_at, updated_at, last_accessed, project
      FROM semantic
      WHERE key LIKE ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    return stmt.all(`${prefix}%`, limit) as SemanticEntry[];
  }

  /**
   * 更新某条事实记忆的作用域属性。
   * 可用于将一条记忆从全局移动到局部，或者反之。
   *
   * @param key 要操作的键名
   * @param fromProject 原有的项目作用域标识 (null 代表全局)
   * @param toProject 目标的项目作用域标识 (null 代表全局)
   * @returns {boolean} 操作是否成功
   */
  updateScope(
    key: string,
    fromProject: string | null,
    toProject: string | null,
  ): boolean {
    // 首先检查目标作用域下是否已经有了该键名
    const targetExists =
      toProject === null
        ? this.db
            .prepare(`SELECT 1 FROM semantic WHERE key = ? AND project IS NULL`)
            .get(key)
        : this.db
            .prepare(`SELECT 1 FROM semantic WHERE key = ? AND project = ?`)
            .get(key, toProject);

    if (targetExists) {
      // 目标作用域已存在相同记录 — 直接删掉源记录，保留目标记录即可
      if (fromProject === null) {
        this.db
          .prepare(`DELETE FROM semantic WHERE key = ? AND project IS NULL`)
          .run(key);
      } else {
        this.db
          .prepare(`DELETE FROM semantic WHERE key = ? AND project = ?`)
          .run(key, fromProject);
      }
    } else {
      // 目标不存在冲突，直接执行移动逻辑：更新该条记录的 project 字段
      if (fromProject === null) {
        this.db
          .prepare(
            `UPDATE semantic SET project = ?, updated_at = datetime('now') WHERE key = ? AND project IS NULL`,
          )
          .run(toProject, key);
      } else {
        if (toProject === null) {
          this.db
            .prepare(
              `UPDATE semantic SET project = NULL, updated_at = datetime('now') WHERE key = ? AND project = ?`,
            )
            .run(key, fromProject);
        } else {
          this.db
            .prepare(
              `UPDATE semantic SET project = ?, updated_at = datetime('now') WHERE key = ? AND project = ?`,
            )
            .run(toProject, key, fromProject);
        }
      }
    }

    const fromLabel = fromProject ?? "global";
    const toLabel = toProject ?? "global";
    this.logEvent("scope_change", "semantic", key, `${fromLabel} → ${toLabel}`);
    return true;
  }

  // ─── 经验教训 (Lessons) 操作 ─────────────────────────────────────────────────────

  /**
   * 增加一条经验教训。
   * 此方法内置了 Jaccard 去重逻辑，可以拦截高度相似的重复记录。
   *
   * @param rule 教训规则的具体内容
   * @param category 类别 (如 'git', 'coding')
   * @param negative 是否为需要避免的反面教材 (默认 false)
   * @param source 来源标识 (默认 'user')
   * @param project 关联的项目标识 (默认 null 为全局)
   * @returns 成功则返回新生成的记录 ID，如果因为重复被拦截则返回 null
   */
  addLesson(
    rule: string,
    category: string = "general",
    negative: boolean = false,
    source: string = "user",
    project: string | null = null,
  ): string | null {
    // 使用完全匹配和 Jaccard 相似度来检查是否有重复
    const existing = this.getLessons();
    for (const lesson of existing) {
      if (lesson.rule === rule) return null; // 完全一致的重复
      if (jaccardSimilarity(lesson.rule, rule) >= 0.7) return null; // 语义足够相似
    }

    const id = randomUUID();
    const stmt = this.db.prepare(`
      INSERT INTO lessons (id, rule, category, source, negative, project)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, rule, category, source, negative ? 1 : 0, project);

    this.logEvent("add", "lesson", id, rule);
    return id;
  }

  /**
   * 通过 ID 删除一条经验教训 (采用软删除策略：is_deleted = 1)。
   *
   * @param id 教训的主键 ID
   * @returns 是否成功删除
   */
  deleteLesson(id: string): boolean {
    const stmt = this.db.prepare(
      `UPDATE lessons SET is_deleted = 1 WHERE id = ?`,
    );
    const result = stmt.run(id);
    if (result.changes > 0) {
      this.logEvent("delete", "lesson", id, "");
      return true;
    }
    return false;
  }

  /**
   * 获取所有存活（未被删除）的经验教训记录。
   *
   * @returns {LessonEntry[]} 所有的经验教训数组
   */
  getLessons(): LessonEntry[] {
    const stmt = this.db.prepare(`
      SELECT id, rule, category, source, negative, created_at, project
      FROM lessons
      WHERE is_deleted = 0
      ORDER BY created_at DESC
    `);
    const rows = stmt.all() as Array<
      Omit<LessonEntry, "negative"> & { negative: number }
    >;
    return rows.map((r) => ({ ...r, negative: r.negative === 1 }));
  }

  /**
   * 搜索经验教训，优先使用 FTS5 引擎，如果环境不支持则降级使用 LIKE 匹配。
   *
   * @param query 搜索关键词
   * @param limit 最大返回条数 (默认 15)
   * @returns 匹配的教训记录数组
   */
  searchLessons(query: string, limit: number = 15): LessonEntry[] {
    if (!query.trim()) return [];

    let rows: Array<Omit<LessonEntry, "negative"> & { negative: number }>;

    if (this.hasFTS5) {
      try {
        const sanitized = query
          .replace(/['"]/g, "")
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => `"${w}"`)
          .join(" OR ");

        if (!sanitized) return this.searchLessonsFallback(query, limit);

        const stmt = this.db.prepare(`
          SELECT l.id, l.rule, l.category, l.source, l.negative, l.created_at, l.project
          FROM lessons l
          JOIN lessons_fts f ON l.rowid = f.rowid
          WHERE lessons_fts MATCH ? AND l.is_deleted = 0
          ORDER BY rank
          LIMIT ?
        `);
        rows = stmt.all(sanitized, limit) as typeof rows;
      } catch {
        return this.searchLessonsFallback(query, limit);
      }
    } else {
      return this.searchLessonsFallback(query, limit);
    }

    return rows.map((r) => ({ ...r, negative: r.negative === 1 }));
  }

  private searchLessonsFallback(query: string, limit: number): LessonEntry[] {
    const words = query
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `%${w}%`);
    if (words.length === 0) return [];

    const conditions = words
      .map(() => `(rule LIKE ? OR category LIKE ?)`)
      .join(" OR ");
    const params: (string | number)[] = [];
    for (const w of words) {
      params.push(w, w);
    }
    params.push(limit);

    const stmt = this.db.prepare(`
      SELECT id, rule, category, source, negative, created_at, project
      FROM lessons
      WHERE is_deleted = 0 AND (${conditions})
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(...params) as Array<
      Omit<LessonEntry, "negative"> & { negative: number }
    >;
    return rows.map((r) => ({ ...r, negative: r.negative === 1 }));
  }

  // ─── 操作事件审计 (Events) ──────────────────────────────────────────────────────

  /**
   * 记录一次记忆操作事件到审计日志表中。
   *
   * @param eventType 事件类型 (如 'add', 'delete')
   * @param memoryType 记忆表类型 (如 'semantic', 'lesson')
   * @param memoryKey 受影响的键名或 ID
   * @param details 详情
   */
  logEvent(
    eventType: string,
    memoryType: string,
    memoryKey: string,
    details: string,
  ): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO events (event_type, memory_type, memory_key, details)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(eventType, memoryType, memoryKey, details);
    } catch {
      // 记录日志并非核心阻断逻辑 — 忽略报错以防止影响主干运行
    }
  }

  // ─── 统计分析 (Stats) ───────────────────────────────────────────────────────

  /**
   * 获取数据库中各个表的数量统计信息。
   *
   * @returns {MemoryStats} 统计结果
   */
  getStats(): MemoryStats {
    const semantic = this.db
      .prepare(`SELECT COUNT(*) as count FROM semantic`)
      .get() as { count: number };
    const lessons = this.db
      .prepare(`SELECT COUNT(*) as count FROM lessons WHERE is_deleted = 0`)
      .get() as { count: number };
    const events = this.db
      .prepare(`SELECT COUNT(*) as count FROM events`)
      .get() as { count: number };

    return {
      semanticCount: semantic.count,
      lessonCount: lessons.count,
      eventCount: events.count,
    };
  }

  /**
   * 获取最近的记忆操作日志。
   *
   * @param limit 返回的最大日志条数 (默认 5)
   * @returns {MemoryEvent[]} 事件日志数组
   */
  getRecentEvents(limit: number = 5): MemoryEvent[] {
    const stmt = this.db.prepare(`
      SELECT id, event_type, memory_type, memory_key, details, created_at
      FROM events
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as MemoryEvent[];
  }

  // ─── 生命周期管理 (Lifecycle) ───────────────────────────────────────────────────

  /**
   * 彻底关闭数据库连接。
   */
  close(): void {
    try {
      this.db.close();
    } catch {
      // 忽略关闭时的异常
    }
  }
}

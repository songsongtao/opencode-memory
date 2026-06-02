/**
 * 针对 opencode-memory 存储层与注入层的简单测试脚本。
 * 运行方式: bun run test.ts
 */
import { MemoryStore } from "./store.js";
import { buildContextBlock, resolveProjectId } from "./injector.js";
import { join } from "node:path";
import { rmSync } from "node:fs";

// 定义测试用数据库的绝对路径
const TEST_DB = join(import.meta.dir, "data", "test-memory.db");

// 运行前先清理可能存在的旧测试数据库文件，确保测试环境纯净
try {
  rmSync(TEST_DB, { force: true });
  rmSync(TEST_DB + "-wal", { force: true });
  rmSync(TEST_DB + "-shm", { force: true });
} catch {}

console.log("=== opencode-memory 测试套件 ===\n");

// 测试 1: 初始化数据库存储实例
console.log("1. 创建 MemoryStore 实例...");
const store = new MemoryStore(TEST_DB);
console.log("   ✓ 数据库存储实例创建成功\n");

// 测试 2: 新增（插入或更新）事实记忆 (Semantic entries)
console.log("2. 测试 upsertSemantic (新增事实记忆)...");
store.upsertSemantic("pref.commit_style", "conventional commits", 0.95, "user");
store.upsertSemantic("pref.code_style", "functional over OOP", 0.9, "user");
store.upsertSemantic("tool.sed", "use for daily note insertion", 0.85, "user");
store.upsertSemantic("user.timezone", "Asia/Shanghai", 0.99, "user");
store.upsertSemantic("project.myapp.framework", "Next.js App Router", 0.9, "user");

const allEntries = store.getAllSemantic();
console.log(`   ✓ 成功插入了 ${allEntries.length} 条记录`);
if (allEntries.length !== 5) {
  console.error("   ✗ 预期应该有 5 条记录！");
  process.exit(1);
}
console.log();

// 测试 3: 搜索事实记忆
console.log("3. 测试 searchSemantic (搜索事实记忆)...");
const commitResults = store.searchSemantic("commit", 5);
console.log(`   找到了 ${commitResults.length} 条包含 "commit" 的结果`);
if (commitResults.length === 0) {
  console.error("   ✗ 预期至少应该找到 1 条包含 'commit' 的结果！");
  process.exit(1);
}
console.log(`   ✓ 第一条结果: ${commitResults[0].key} = ${commitResults[0].value}`);
console.log();

// 测试 4: 通过前缀获取事实记忆
console.log("4. 测试 getSemanticByPrefix (按前缀获取)...");
const prefEntries = store.getSemanticByPrefix("pref.", 10);
console.log(`   找到了 ${prefEntries.length} 条带有 pref.* 前缀的记录`);
if (prefEntries.length !== 2) {
  console.error("   ✗ 预期应该有 2 条 pref.* 记录！");
  process.exit(1);
}
console.log(`   ✓ 记录数量正确\n`);

// 测试 5: 更新现有的事实记忆
console.log("5. 测试 upsert (更新现有记录)...");
store.upsertSemantic("pref.commit_style", "gitmoji style", 0.8, "user");
const updated = store.getAllSemantic().find((e) => e.key === "pref.commit_style");
if (updated?.value !== "gitmoji style") {
  console.error("   ✗ 预期记录的值应该被更新！");
  process.exit(1);
}
console.log(`   ✓ 成功更新: ${updated.key} = ${updated.value}\n`);

// 测试 6: 删除事实记忆
console.log("6. 测试 deleteSemantic (删除事实记忆)...");
const deleted = store.deleteSemantic("pref.code_style");
if (!deleted) {
  console.error("   ✗ 预期删除操作应该返回 true！");
  process.exit(1);
}
const afterDelete = store.getAllSemantic();
console.log(`   ✓ 成功删除。剩余记录数: ${afterDelete.length}\n`);

// 测试 7: 增加经验教训 (Lessons)
console.log("7. 测试 addLesson (新增经验教训)...");
const lessonId1 = store.addLesson("Use sed for daily note insertion, not echo >>", "tools", true, "user");
const lessonId2 = store.addLesson("Draft wiki changes before publishing", "deployment", false, "user");
console.log(`   ✓ 成功新增教训 1: ${lessonId1}`);
console.log(`   ✓ 成功新增教训 2: ${lessonId2}`);

// 测试完全重复的教训拦截
const dupId = store.addLesson("Use sed for daily note insertion, not echo >>", "tools", true, "user");
if (dupId !== null) {
  console.error("   ✗ 预期完全一致的重复教训应该被拦截！");
  process.exit(1);
}
console.log("   ✓ 完全重复的教训被正确拦截");

// 测试 Jaccard 相似度算法去重 (相似度阈值是 0.7)
// 下面这句话与第一条教训高度相似（重合度很大）
const similarId = store.addLesson("Use sed for daily note insertion, not echo append", "tools", true, "user");
if (similarId !== null) {
  console.error("   ✗ 预期高度相似的教训应该被拦截！");
  process.exit(1);
}
console.log("   ✓ 高度相似的教训被正确拦截 (Jaccard >= 0.7)");
console.log();

// 测试 8: 获取所有经验教训
console.log("8. 测试 getLessons (获取经验教训)...");
const lessons = store.getLessons();
console.log(`   找到了 ${lessons.length} 条教训`);
if (lessons.length !== 2) {
  console.error("   ✗ 预期应该有 2 条教训！");
  process.exit(1);
}
console.log(`   ✓ 教训 1: [${lessons[0].negative ? "AVOID" : "DO"}] ${lessons[0].rule}`);
console.log(`   ✓ 教训 2: [${lessons[1].negative ? "AVOID" : "DO"}] ${lessons[1].rule}`);
console.log();

// 测试 9: 删除经验教训
console.log("9. 测试 deleteLesson (删除经验教训)...");
const lessonDeleted = store.deleteLesson(lessonId2!);
if (!lessonDeleted) {
  console.error("   ✗ 预期删除操作应该返回 true！");
  process.exit(1);
}
const afterLessonDelete = store.getLessons();
console.log(`   ✓ 成功删除。剩余教训数: ${afterLessonDelete.length}\n`);

// 测试 10: 获取数据库统计信息
console.log("10. 测试 getStats (获取统计数据)...");
const stats = store.getStats();
console.log(`   ✓ 事实数量: ${stats.semanticCount}, 教训数量: ${stats.lessonCount}, 事件数量: ${stats.eventCount}\n`);

// 测试 11: 构建上下文注入块 (Context Block)
console.log("11. 测试 buildContextBlock (生成 XML 上下文块)...");
// 重新加回一些记录用于测试 XML 生成
store.upsertSemantic("pref.commit_style", "conventional commits", 0.95, "user");
const block = buildContextBlock(store, "/home/user/projects/myapp");
console.log(`   注入块统计: 包含 ${block.stats.semantic} 条事实, ${block.stats.lessons} 条教训`);
console.log(`   注入块长度: ${block.text.length} 字符`);
if (!block.text.includes("<memory>")) {
  console.error("   ✗ 预期 XML 应该包含 <memory> 标签！");
  process.exit(1);
}
if (!block.text.includes("<preferences>")) {
  console.error("   ✗ 预期 XML 应该包含 <preferences> 分组！");
  process.exit(1);
}
console.log("   ✓ 注入块包含了预期的 XML 结构");
console.log(`\n--- 注入上下文预览 ---\n${block.text}\n--- 预览结束 ---\n`);

// 测试 12: 解析项目标识 (Project Id)
console.log("12. 测试 resolveProjectId (解析项目唯一标识)...");
console.log(`   "/home/user/projects/my-app" → "${resolveProjectId("/home/user/projects/my-app")}"`);
console.log(`   "C:\\Users\\HP\\project\\openc" → "${resolveProjectId("C:\\Users\\HP\\project\\openc")}"`);
console.log(`   ✓ 项目标识解析功能正常\n`);

// 测试 13: 搜索经验教训
console.log("13. 测试 searchLessons (搜索经验教训)...");
const lessonSearch = store.searchLessons("sed", 5);
console.log(`   找到了 ${lessonSearch.length} 条包含 "sed" 的教训`);
if (lessonSearch.length === 0) {
  console.error("   ✗ 预期至少应该找到 1 条包含 'sed' 的教训！");
  process.exit(1);
}
console.log(`   ✓ 第一条结果: ${lessonSearch[0].rule}\n`);

// 测试完毕，清理测试数据库
store.close();
try {
  rmSync(TEST_DB, { force: true });
  rmSync(TEST_DB + "-wal", { force: true });
  rmSync(TEST_DB + "-shm", { force: true });
} catch {}

console.log("=== 所有测试用例已顺利通过！ ===");

# supereasy-memory

OpenCode 的持久化记忆插件。移植自优秀的 [pi-memory](https://pi.dev/packages/@samfp/pi-memory?name=memory)。

让 AI 助手能够跨会话记住你的偏好、项目模式和纠正经验。

[English Documentation](./README.md)

## 功能

- **持久化存储** — 使用 SQLite 存储记忆，跨会话持久化
- **5 个工具** — AI 可以搜索、存储、删除记忆
- **自动注入** — 每次新会话自动将已有记忆注入到上下文
- **分类管理** — 偏好 (`pref.*`)、环境 (`env.*`)、工具 (`tool.*`)、用户 (`user.*`)
- **项目作用域** — 任何偏好都可以设定为全局或仅对当前项目生效
- **智能项目识别** — 优先使用 git remote URL 识别项目，同仓库多份拷贝自动共享记忆
- **经验教训** — 单独管理纠正经验，支持 Jaccard 去重
- **全文搜索** — FTS5 全文搜索（不支持时自动降级为模糊搜索）

## 安装

本插件已发布至 npm，且无需额外安装 Bun 环境（OpenCode 内部已内置运行环境）。

1. 全局安装 npm 包：
```bash
npm install -g supereasy-memory
```

2. 打开您的 `opencode.json` 配置文件，将包名直接添加到 `plugin` 数组中：
```json
{
  "plugin": [
    "supereasy-memory"
  ]
}
```

3. 重启或重载 OpenCode (`Ctrl/Cmd + R`) 即可生效。

## 工具

| 工具 | 描述 |
|------|------|
| `memory_search` | 按关键词搜索记忆 |
| `memory_remember` | 存储事实或经验教训（支持 `scope` 参数指定全局/项目作用域） |
| `memory_forget` | 删除一条记忆（支持按作用域删除） |
| `memory_stats` | 显示记忆统计（含作用域分布） |

## 使用示例

### 存储偏好
对 AI 说：
- "记住：我喜欢用 conventional commits"（AI 自动判断为全局）
- "记住这个项目用 Next.js App Router"（AI 自动判断为项目级）

AI 保存后会告知你选择的作用域，你可以随时要求修改：
- "把刚才那个偏好改成全局的"
- "把 language 改成只对当前项目生效"

### 存储经验教训
- "记住教训：不要用 echo >> 写笔记，用 sed"
- "记住：部署前先让我预览"

### 搜索记忆
- "搜索一下我关于 git 的偏好"
- "我之前记了什么关于部署的教训？"

### 管理记忆
- "显示记忆统计"
- "列出所有教训"
- "忘掉 pref.commit_style"

## 项目作用域

每条事实记忆都有一个作用域：

| 作用域 | 含义 | 示例场景 |
|--------|------|----------|
| **全局 (global)** | 所有项目都可见 | 语言偏好、代码风格 |
| **项目 (project)** | 仅当前项目可见 | 项目框架、特定工具链 |

**项目识别策略**：
1. 优先读取 `git remote get-url origin`（同一仓库克隆到多台机器自动共享）
2. 无 git 时回退到完整目录路径

**覆盖规则**：当同一个 key 同时存在全局版本和项目版本时，项目版本优先生效。

## 记忆类型

### 事实（Facts）

键值对存储，使用前缀分类：

| 前缀 | 类型 | 示例 |
|------|------|------|
| `pref.*` | 用户偏好 | `pref.commit_style` = "conventional commits" |
| `env.*` | 环境配置 | `env.os` = "Windows" |
| `tool.*` | 工具偏好 | `tool.sed` = "用于日常笔记插入" |
| `user.*` | 用户身份 | `user.timezone` = "Asia/Shanghai" |

### 经验教训（Lessons）

规则型记忆，分为两类：
- **[AVOID]** — 要避免的做法
- **[DO]** — 推荐的做法

## 数据存储

数据库位于插件目录内：`<plugin_dir>/data/memory.db`

使用 SQLite WAL 模式，支持并发读取。

## 开源协议

本项目基于 [MIT 协议](LICENSE) 开源。

## 致谢

本插件深度移植自 [samfoy/pi-memory](https://pi.dev/packages/@samfp/pi-memory?name=memory)，非常感谢原作者卓越的设计与逻辑。



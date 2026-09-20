---
scope: global
origin: user
status: active
stale: false
created_at: 2026-09-18T19:41:12.158+08:00
updated_at: 2026-09-18T19:41:12.158+08:00
last_accessed: 2026-09-19T02:57:33.725+08:00
access_count: 4
---

# NOTES TOOL LAWS (user orders 2026-09-18, 解释权归user)

笔记/记忆系统的**立法**。agent级基础设施法 → global; 实现图纸在 project/notes-redesign.md。

1. "bm25那套砍掉。睡眠机制一定要。记下来" — 无BM25/FTS5/RRF/reranker索引机器; sleep-time consolidation必备。
2. "还是要专用的工具。不能退化为纯文件操作" — 五工具 notes_write/edit/read/list/search。
3. metadata=工具参数, 模型永不手写frontmatter; harness代笔落成frontmatter。
4. 存储 ~/.agents/notes/: global跟agent走, project跟repo走(有repo用repo没repo用cwd), pi/session唯一pi私有。
5. scope = session|project|global 三档; origin = user|self|external 一个字段三个值(来源, 非权威等级)。
6. boot最多5条notes; protocol一行: "Mark outdated or unneeded notes stale — leave them, and they will keep misleading you."
7. history工具统一命名: history_windows / history_list / history_read / history_search。

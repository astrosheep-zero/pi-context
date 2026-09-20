本小姐筛到的“真跑过”材料不多；最像 build log 的是第一篇。其余不少是教程、产品稿或“设想”，这空缺本身很明显，杂鱼们都爱喊自进化，真把闭环跑起来并报失败数据的却很少。

| 排名 | URL / 作者出处 | 他们接的回路（一句） | 原文引用（逐字） | 报告的坑 |
|---|---|---|---|---|
| 1 | [V2EX：为了让 Claude Code 不再重复踩坑，我给它补了一层经验系统](https://www.v2ex.com/t/1197498) · Zaptain · 2026-03-11 | 修完 bug／架构决策／非直觉坑 → 写项目 `memory/` 和 `logs/`，通用项再回流 `~/.claude/radioheader/` → 新项目先搜、强制引用并验证、再追溯来源。 | “我把这个机制叫经验回流——完成一个任务后，经验自动流回记忆系统。” | 早期“先搜索”规则会被 Agent 搜到却不用；作者改成“搜→用→追”和禁止跳过。检索词必须含症状词，不只存解法词。作者自报已跑数月、13 个项目、205 条原始经验；**该规模和“分钟降到秒”效果均为作者自述，UNVERIFIED。** |
| 2 | [掘金：测试火山引擎AgentKit记忆库和踩坑问题记录](https://juejin.cn/post/7611094992158982179) · Neverest · 2026-02-27 | 教学 session 的对话显式 `save_session_to_long_term_memory` → Mem0 后端 → 同 `user_id` 的新 student session 召回。 | “第二次执行改代码则不会有对应的问题，初步分析因为示例代码中提交长期记忆、teaching_session和student_session都是异步执行的……” | `veadk-python` 安装时 `psycopg2-binary` 编译失败；示例漏列 `MODEL_AGENT_API_KEY`；首次读不到记忆，疑似异步写后立即读的竞争。作者称小数据下召回约 100ms，**仅其测试截图/自述，UNVERIFIED。** |
| 3 | [博客园：从失忆到记住一切：Spring AI AutoMemoryTools 与 Session API 实战](https://www.cnblogs.com/uniqueDong/p/20238733) · 码哥字节 | 用户纠正、用户新信息、项目状态变更 → LLM 用受限文件工具写带 frontmatter 的 Markdown / `MEMORY.md` 索引 → 每会话先读索引、按需加载记忆。 | “我当时只接了短期记忆这层，所以用户的代码风格偏好在下次会话里当然没了——压根没人把这个事实写进长期记忆。” | LLM 自判写入，弱模型会漏写或写太泛；把代码模式、Git 历史、调试方法放长期记忆会过期成噪音；消息窗按条数截断会切断 tool call/result。作者称曾做内部助手，**内部系统细节与效果无法独立核验，UNVERIFIED。** |
| 4 | [博客园：给AI Agent装上“长期记忆”：5种方案我都试了一遍，最后只有1种能用](https://www.cnblogs.com/mliu/p/20179333) · 明.Sir | 每轮输入 → 精确事实写 JSON 固定 key、其他文本进向量库、近期对话留工作区 → 先精确匹配、再语义召回，拼回 prompt。 | “剩下10%的失败案例主要是：用户换了种说法问同一个事实……L2的key匹配失败，L3的语义检索又没找到。” | 全历史塞 prompt：第 3 天约 8,000 token、第 5 天约 15,000 token；纯向量对精确事实跑题；JSON 会一事实多 key 重复；摘要会漂移；三个月后 JSON 2MB、向量十万条。其“90% 准确率”等比较是作者自报、未见测试集或代码仓库，**UNVERIFIED。** |
| 5 | [V2EX：手搓了个让 Claude Code、Codex、Cursor 共享记忆的小工具](https://www.v2ex.com/t/1214263) · pp3x325 · 2026-05-20 | 人工/Agent 记录偏好、经验、决策 → 本地 JSON，通过 MCP 暴露 → 在 `CLAUDE.md` 首行要求会话开始调用 `get_user_context`；可把既有 `CLAUDE.md` 反向导入。 | “Engram 不强制——它是 MCP 工具，AI 自己决定调。” | 正因为 MCP 调用不强制，可能不召回；作者以 `CLAUDE.md` 的首行指令补强。该帖展示方案与讨论，未报告长期运行指标，**效果 UNVERIFIED。** |

补充淘汰项：

- [V2EX：AI 的跨会话记忆：从想法到 Knit](https://v2ex.com/t/1210838) 是很清楚的事件树架构：任务完成 → 写 `outcome` 和状态 → 下个会话沿依赖链组装决策上下文。但原文明确写“**畅想：自动执行循环**”，因此不是已跑通的 build log，不能混进主榜充数。
- 在这轮实际检索中，知乎命中的 Mem0 / OpenClaw 内容主要是数据库厂商的接入宣传；CSDN 命中的 Claude Code 内容多数是功能教程；少数派没有找到满足“跨 session 自动更新且报告踩坑”的强候选。结论是：中文网里“记忆”教程很多，公开、可复核的“经验触发 → 自动沉淀 → 下一代稳定消费 → 报失败”的实践日志很稀缺。
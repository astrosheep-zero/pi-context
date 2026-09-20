---
scope: project
origin: self
status: active
stale: false
created_at: 2026-09-18T19:07:07.000+08:00
updated_at: 2026-09-18T19:07:07.000+08:00
last_accessed: 2026-09-18T19:47:51.191+08:00
access_count: 1
source_window: pcw:01a08ffa:31b6308e
---

# 下一代笔记/记忆工具 — 设计定稿 (2026-09-18)

## ★ USER LAW (item: user order 2026-09-18, verbatim: "bm25那套砍掉。睡眠机制一定要。记下来")
1. **砍掉 BM25 那套** — 不设关键词索引机器: 无 BM25/FTS5/RRF/reranker 管道, 检索引擎不当系统骨架。
2. **睡眠机制一定要** — sleep-time consolidation 是必备组件, 不是可选项。
(解释权归 user; 不许以水tain-down, 不许复活已砍方案除非明说+新证据 — L5)

## 形态 (模型原生, "检索=行为不是管道")
- **正典 = 纯 md 文件**, 一个 fact 一个家; 模型自己读/写/组织/命名 (Anthropic memory tool 形态, memory_20250818 GA, 内部eval +39%)。
- **模型自维护 TOC/地图**, 常驻在场 — 解决"模型不知道自己不知道什么"。harness 只保证两件事: ①地图在场 ②写入发生 (capture)。这两个是触发, 不是检索。
- **检索 = JIT 模型拉取** (read/grep 直接读文件, agent-as-retriever; Claude Code 拆 vector 换 grep "outperformed everything by a lot"; Amazon AAAI2026: agentic keyword = 94.5% RAG faithfulness 零向量库)。深挖 = subagent 带全新上下文去原始历史里做研究 (retrieval as delegation)。
- **三层三动词**: 原始层 append-only(事件不可变) / 正典层原地改写(edit, 不堆拷贝; supersede 标记) / 地图层 = 模型维护的 TOC (注意: 不是"可重建向量cache"——那套已砍)。

## 睡眠班 (MANDATORY)
- 离线模型判断, 不是确定性公式: 去重/冲突对账(并存·版本化·待核验·归档)/晋升/TOC维护/衰减刷新。
- 参照: Letta sleep-time compute (test-time算力省5x, +13~18%); Google ADK always-on (Flash-Lite 24/7, 无向量库); Hermes Curator (auxiliary model, 7天一轮, active→stale→archived 可逆可审计)。
- 诚实边界(记录但不违令): sleep-time 在高 test-time 预算档 SWE-Features 反输, 查询可预测才最有效; 设计成离线异步不挡主路。

## 触发三层 (harness 的 push, 模型零参与决定)
捕获=事件钩子(session end/stop) / 召回=地图常驻+模型JIT (无预注入管道) / 晋升=睡眠班模型判断+计数门槛(复发3x/2窗口或user纠正直达, Wes配方)。

## 标准挂钩
检索=行为=可学习=召回机制本身可RSI; 但必须带裁判——无独立eval只能叫customization(dsh报告结论, 咬在THE STANDARD上)。建eval是第一块砖。

## 现状 (2026-09-18 晚更新)
**notes-v2 已落地 pi-context main** (42704f8 五工具+真文件store / b7baa09 history改名; reviewer=kimi-k-2-8 SATISFIED; 204/204)。契约 kei/real-file-notes-five-tools-over-5b22 全档可查。下一块: 睡眠班契约(图纸见"睡眠班"节+爷的三层画法: 薄runner/playbook七件事/trash+报告护栏; recurrence在合并时数副本不扫history——这是root的小发明)。再下一块: eval(咬THE STANDARD)。相关研究: ~/playground/rsi-research/。

## 开放问题①: 现有 pi-context notes 工具的死法 — 已结案 (user两连推翻root)
**砍存储层, 留行为层, 专用工具保留**。session级虚拟fs → ~/.agents/notes/真md; pi-context保留窗口管理+两触发职责(地图在场/写入发生); 工具表五件套见下。

## Anthropic memory tool schema (源头: docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool + SDK BetaMemoryTool20250818Command, 2026-09-18取证)
- 声明: `{"type":"memory_20250818","name":"memory"}` — name固定memory, 开发者不定义input schema (Anthropic-provided)。
- client-side: Claude只发请求, 应用执行; `/memories` 前缀由handler映射到真实存储(目录/DB/key-value皆可)。
- 六命令: view / create / str_replace / insert(行号锚) / delete(递归拒根) / rename(不覆盖拒根)。
- 约定: 目录列表2层深+可读size+tab分隔; 文件view带6位行号; >16000字符截断; str_replace多处匹配报错列行号; 路径越狱防护是handler责任。
- ★触发: 工具出现在tools数组→API自动注入"先查看/memories, 假设上下文随时被重置"。工具的**在场**即触发器——专用工具不退化的核心理由(user对)。
- 安全: 敏感信息剥离/文件大小cap/长期未访问过期——全在handler侧。

## edit动词 landscape (2026-09-18, 全部源文核实)
共识: 文本锚+默认唯一+响报错 = 全行业(pi/Claude/dsh×2全同)。pi edit批量原子同快照=独家; Claude重复命中报错带行号(抄); dsh replace_all逃生门(抄); dsh read-before-edit事件门(由pi-context钩子做); undo不做(Anthropic尸检)。

## ★ USER LAW 工具表定稿 (verbatim: "notes_write / notes_edit / notes_read / notes_list / notes_search 需要保留这几个")
- `notes_write` (path, content, scope=session, origin=self, stale? — 覆写非追加)
- `notes_edit` (path, edits[]?, scope?, origin?, stale?, replace_all? — 批量唯一锚+报错带行号+全或无原子; body-scoped碰不到frontmatter; edits可省=metadata-only更新; scope setter=搬文件重名拒; 返回带diff——pi同款generateDiffString)
- `notes_read` (保留: 虚拟路径普通read够不着; 无scope按session→project→global; 副作用只动last_accessed/access_count)
- `notes_list` (scope? pattern? — updated_at desc, 行带scope)
- `notes_search` (query, scope? — 字面子串, offset=body绝对地址)
砍: append死刑(inbox小文件接住); delete/rename不入表(supersede=metadata; 物理删除=睡眠班+trash)。
错误手臂: not_found / 锚0中指名edit_index / 多中带行号 / replace_all零命中同0中 / nothing-to-do / 路径越狱。
二轮补丁: 原子写tmp+rename; size caps继承旧版; TOC.md存在时boot注入其正文(地图在场)。

## ★ USER LAW 存储位置 v2 (SUPERSEDES "~/.agents/notes/pi")
verbatim: "global不应该放到pi里面" + "project也不应该放到pi里面" + "应该是有repo在repo，没repo就cwd"。
**最终布局: `~/.agents/notes/` (env: PI_NOTES_HOME)**
```
├── global/<vpath>.md                   # 跨agent, 无条件在场
├── project/<project-key>/<vpath>.md    # key=<basename>-<sha1(|git root|cwd|)[:8]>
└── pi/session/<session-id>/<vpath>.md  # 唯一pi私有层
```
理由: ~/.agents是跨agent共享地盘; global跟人走, project跟repo走, session是pi概念。

## ★ USER LAW metadata (两段立法: ①"metadata变成参数" ②"metadata进frontmatter")
**模型只传参数, harness把参数落成frontmatter。模型永不手写YAML。** sidecar store方案死(L5); frontmatter衰减挂点由user亲自复活。

## ★ USER LAW metadata 参数全集 (含stale修正)
**① 模型可写(仅经参数口)**: scope(默认session) / origin / stale(语义判断只有在场模型能做; 覆写自动复活)。
**② harness自动**: created_at / updated_at / last_accessed / access_count / source_window。
**③ 睡眠班专属**: status: active/superseded/pending/archived / supersedes指针 / recurrence(次数+跨窗口数)。
**枪毙**: tags / kind·type分类法。**待定**: valid_until(user未拍)。
root教训: 防模型涂鸦防到把语义判断也没收(stale事件)=矫枉过正。

## scope metadata (user提案, root取证背书)
三档 session/project/global。先例: Claude Code四层越近越赢 / Codex global+项目+嵌套 / mem0实体ID分区=复杂度癌症不学 / Anthropic memory tool无scope=我们多半步。**晋升有方向**: 复发门槛=scope升迁; 默认session; 升global需user确认或睡眠班专属; precedence越具体越赢。

## ★ USER LAW origin (verbatim: "只要一个字段。就 user / self / external")
**origin = 一个字段, 三个值: `user` | `self` | `external`。完。**
废除: root初版enum(user判"捞") + 二版结构化套娃(user判"他妈的这么长")。教训: 审计/核验是睡眠班的行为, 不是字段。

## ★ USER LAW history工具改名 (user判"可以")
history_list_windows→history_windows / history_list_items→history_list / history_read_item→history_read / history_search_contents→history_search。已落地(b7baa09)。

**Codex append为什么合理(分析)**: append=盲写安全但日志烂; 原始层可接受正典层致命。append美德由"创建新文件"继承(inbox/<ts>.md, 睡眠班合并)。

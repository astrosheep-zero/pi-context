# dsh（DeepSeek Harness）实操与 evolve 生态核查

核查日期：2026-09-18。除明确标成“推断”或 `UNVERIFIED` 的句子外，每条结论都紧跟可点击来源和原文短引。官方一手材料优先；第三方 README、帖子、视频只证明其作者声称/演示了什么，不当作独立效果证明。

## 是什么（一行，验过的）

**dsh 是 DeepSeek AI 发布、MIT 许可、仍处 developer preview 的开源 agent harness；其模型、工具、会话、loop 与 UI 皆可作为 Cordis 插件组合。** [官方仓库](https://github.com/deepseek-ai/deepseek-harness) 原文：> “DeepSeek Harness (`dsh`) is an open-source agent harness developed by DeepSeek AI.”、> “THERE WILL BE COMPATIBILITY-BREAKING CHANGES.”；[官方产品页](https://www.deepseek.com/harness/) 原文：> “模型、工具、技能、会话、沙箱、存储、循环、调度、UI 等所有 Agent 能力均由插件提供”。

这也核实了与 DeepSeek 官方的关系：仓库组织为 `deepseek-ai`，README 直接自称由 DeepSeek AI 开发，且 `deepseek.com/harness` 是官方链接；不是仅凭 repo 名猜的。上面的开发者预览限定意味着 API/安装说明可能变更。

## 安装与日常玩法

### 最短可跑路径和 Web UI

```sh
# 先安装 Node.js；官方最短路径
npx @deepseek-ai/dsh web

# 从源码跑（用于改源码/本地插件）
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

官方仓库原文：> “The command starts the Web UI at `http://127.0.0.1:3080` by default”；源码路径原文：> “`pnpm run build` prepares the repository artifacts.” [README](https://github.com/deepseek-ai/deepseek-harness)。SSH 环境只会打印 host URL、`--no-open` 不自动开浏览器，也是官方 README 的明示行为。

Web UI 是当前正式入口，而非桌面/TUI：官方架构页将 `dsh web` 列为支持的 profile 启动器；原文：> “The shipped applications are `dsh web` … `headless`, `sdk`, `sdk-minimal`, and `acp`.” [架构](https://deepseek-harness.github.io/deepseek-harness/en/reference/)。社区 B 站实测视频的简介声称覆盖 “WebUI远程控制、多模型接入、执行轨迹、插件系统、任务分支、代码分析”；这是演示范围，**非本报告复现**。[视频](https://www.bilibili.com/video/BV1W7gP6CEEV/)

### profile / bundle / patch / registry：实际要改哪一层

| 名词 | 已核实的操作含义 |
|---|---|
| Profile | `$DSH_HOME/profiles/<name>` 下的可启动组合，`package.json` 的 `dsh.profile.bundles` 是有序 bundle 列表；自身 `cordis.patch.yml` 是用户覆盖层。[官方教程](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish) 原文：> “A profile is a directory under `$DSH_HOME/profiles/<name>` … ‘which bundles compose this setup, in what order?’” |
| Bundle | 可分发 npm 包，`package.json` 的 `dsh.bundle.patch` 指向要插/改 Cordis rows 的 patch；bundle 与 profile “Nothing is both.” [同上](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish) |
| 层叠顺序 | profile 所列 bundles → profile patch → home patch → `--patch`；高层可替换 row 或插新 row。原文：> “each bundle … then the profile's `cordis.patch.yml`, then the home-level one, then any `--patch` overlay.” [官方架构](https://deepseek-harness.github.io/deepseek-harness/en/reference/) |
| CLI 安装 | `dsh plugin --profile demo add ./hello-plugin`；首次会建带 `@deepseek-ai/dsh-base` 的 profile 并追加 bundle；remove 同时移依赖和层。 [官方教程](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish) 原文：> “`dsh plugin --profile demo remove dsh-hello-plugin` removes both the dependency and the layer.” |
| Cordis registry | **不是插件商店**，是 runtime 的加载/DI registry：`ctx.plugin()` 返回 Fiber；`ctx.inject()` 在依赖服务可用时运行，服务变化会卸载重跑。 [Registry API](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/registry) 原文：> “Plugin loading and dependency injection.”、> “unloaded and re-run whenever a required service changes.” |

诊断组合而不是猜配置：`dsh --profile web --dump-config`。官方说它会打印实际 boot tree，且每一 row 都能被 patch 替换。[架构](https://deepseek-harness.github.io/deepseek-harness/en/reference/)

### workflow 与 agent teams

* 普通一两项委派用 `subagent`；独立子 agent 不继承本对话，prompt 必须完整。官方 tool catalog 原文：> “It does not share this conversation's context”；默认等待，可 `run_in_background: true` 后用 job 工具收取。[Tool catalog](https://deepseek-harness.github.io/deepseek-harness/en/reference/tool-catalog)
* 大规模分解用可选的 `workflow` 插件：模型提交**纯 JavaScript**（不是 TS）脚本，使用 `agent()`、`parallel()`、`pipeline()`、`phase()`、`log()`，最后 `return` JSON。 [workflow README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow/README.md) 原文：> “The tool blocks the parent turn until the whole workflow settles”；> “A plain JavaScript body (not TypeScript)”。
* “agent teams”不是一个已找到的官方独立产品名；可核实的等价操作面是 named subagent provider registry + continuable children + `send_message`/`interrupt_agent`/`list_agents` 控制插件。 [Subagent subsystem](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/subagent) 原文：> “multiple provider implementations coexist in one context, registered by name”；> “the optional global `send_message`, `interrupt_agent`, and `list_agents` controls”。

## 插件开发 loop

### 最小开发闭环

1. 写 ESM/TS 模块，导出 `apply(ctx)`（也可 object/class）。官方最小形式原文：> “a TypeScript module that exports an `apply` function”。[首个插件](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/)
2. 如需 `tools`/`llm`，导出 `inject = ['tools']`；依赖到位才执行。原文：> “The framework waits for every required service before loading the plugin.” [同上](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/)
3. 开发时将**绝对路径**插件 row 写进 patch，`pnpm dsh web --patch ./scratch-plugin/cordis.yml`；官方明确说 module path 必须绝对。 [同上](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/)
4. 打包时写 `dsh.bundle.patch`、`cordis.patch.yml`，再 `dsh plugin --profile <name> add ./plugin`；先 `--dump-config` 看层是否真的出现。[发布教程](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)

工具应注册在 `ctx.tools`；官方工具包给 `defineTool()` 类型化 helper，MCP 走 `ctx.tools.register()` 原始 JSON schema。 [extension cookbook](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/extension-cookbook) 原文：> “A tool registers on `ctx.tools`”；> “MCP … `ctx.tools.register()`”。

### Cordis 4 Fiber 语义（为何能热挂/可逆）

已核实的 DSH 发行包为 `@deepseek-ai/cordis` **4.0.2**（核查日 npm 页面）；其描述为 “explicit dependency injection, scoped services, lifecycle-managed cleanup”。[发行页](https://www.npmjs.com/package/%40deepseek-ai/cordis)

* 一个 Fiber = 一次插件 application 的 runtime instance，追踪 dependency、validated config、lifecycle effects、cleanup。 [Fiber API](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/fiber) 原文：> “Runtime instance of one plugin application.”
* `ctx.effect()` 立即执行，收集 disposer；手动 dispose 或 fiber unload 时反序清理，双调 no-op。原文：> “run (in reverse order) … when the fiber unloads”；这就是注册的 tool/listener/timer 不该留下脏状态的结构性依据。[Fiber API](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/fiber)
* `fiber.update(config)` 先校验，再走 `internal/update` waterfall，默认 restart；`fiber.restart()` 则 dispose 后 reload。 [Fiber API](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/fiber) 原文：> “Validate and apply new config, then restart the plugin.”
* 关键限定：hot reload 不等于安全隔离；worker-thread workflow 文档明确说它 “is not a security boundary”。[工作流 worker](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow-worker-thread/README.md)

## evolve 生态与真实用例

### 起点仓库的身份、安装与能力

你给的 URL `github.com/dsh-external/dsh-evolve` 当前 HTTP 重定向到 [william-jin-cmu/dsh-evolve](https://github.com/william-jin-cmu/dsh-evolve)；页面 breadcrumb 也是 `william-jin-cmu / dsh-evolve`。因此“dsh-external org 下还有什么”这一前提为 **UNVERIFIED / 此处是空白**：核查日 GitHub REST 的 `users/dsh-external/repos` 与 `orgs/dsh-external/repos` 都返回空数组，且没有可验证的组织项目清单；不能把作者个人仓库伪称该 org 资产。

该插件 README 的**作者自述/自带 trajectory，不是独立用户证言**：

* `evolve_add(name, source, ...)` 将 ESM 源码和 manifest 存到 `~/.dsh/evolve/<name>.mjs` 后热挂；同名会先卸旧 fiber。原文：> “新工具在下一个 step 就可调用”；> “旧 fiber 先完整卸载”。[主 evolve README](https://github.com/william-jin-cmu/dsh-evolve)
* `evolve_remove` 卸载、删 manifest/source；`evolve_list` 看 name/state/version；`autoRestore` 默认 true。原文：> “重启自动恢复”。[同上](https://github.com/william-jin-cmu/dsh-evolve)
* 安装路径是 `scripts/build.sh` 后 `dsh plugin --profile web add .`；README 明言 registry 通道与 profile bundle “二选一，不要双挂载”。[同上](https://github.com/william-jin-cmu/dsh-evolve)
* 它演示了 weather、currency、worklog、brevity guard、morning timer 等；README 声称 brevity guard 出现三次误报、最后 rev5 收敛。这是**项目作者的未独立复现实验声明**，应读作成功演示，不应提升为真实用户成功案例。[同上](https://github.com/william-jin-cmu/dsh-evolve)

现实反例已经存在：该仓库公开 Issues 目前两条都报告 git 安装后没有编译产物/`prepare`，导致无法运行或启动崩溃。 [Issues](https://github.com/william-jin-cmu/dsh-evolve/issues) 原文：> “[Bug] git 安装后无法运行: 无构建产物且连 build 脚本都没有”、> “安装后启动崩溃”。这比 README 的成功轨迹更接近第三方失败报告。

### 另一份同名的自进化插件（不能混淆）

[chenzheshushi-commits/dsh-evolve](https://github.com/chenzheshushi-commits/dsh-evolve) 是不同实现：强调 cross-session memory 与 skill lifecycle，不是上述 session 内任意 ESM 自挂载器。其 README 原文：> “durable cross-session memory with zero-token deterministic recall”；安装为 `dsh plugin --profile web add github:chenzheshushi-commits/dsh-evolve`，并说 “tools are discovered at startup, not hot-reloaded”。

它列出 Node `>=22.5.0`、DSH `0.1.0-rc.7+`，且承认 v0.6.0/更早在 Windows 写 skill proposal 会 `EPERM`，v0.6.1 修复。[需求与修复说明](https://github.com/chenzheshushi-commits/dsh-evolve) 原文：> “Node 20 will not work.”、> “v0.6.0 and earlier threw `EPERM` on Windows”。当前公开 issue 还包括 “a single shared 2-gram recalls unrelated records”；因此其检索准确性成功不能凭 README 接受。[其 issues](https://github.com/chenzheshushi-commits/dsh-evolve/issues)

**独立、可核验的“真实用户成功报告”：此处是空白。** 本轮只找到作者 README 的自述、第三方插件/桌面壳发布，未找到可复现日志或多名独立用户对上述 evolve 运行成功的证言；故不拼凑营销叙事。

## 社区讨论摘录（中英）

### 中文

* [V2EX 技术帖](https://global.v2ex.com/t/1234203)（2026-08-13）把实操入口总结为：> “一行命令 `npx @deepseek-ai/dsh web` 就能启动 Web UI”；并提醒 > “核心插件和基础接口预计还会快速迭代”。这是社区转述，和官方 README 相符但不替代官方。
* 同帖的插件发现线索是评论给出的 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，即 curated list；它证明列表项目存在，**不证明其中条目安全/可用**。原帖原文：> “整理了一个 … 插件精选列表”。
* [知乎 RSI 讨论](https://zhuanlan.zhihu.com/p/2073839461658636357)做了合理但仍属观点的限制：> “Cordis … 不能判断新 Loop 是否真正提高了整体能力。” 这支持把“能热改”与“已经自我改进成功”分开。
* [B站实测](https://www.bilibili.com/video/BV1W7gP6CEEV/)（2026-08-14）自称 “从零开始安装并完整实测”，范围含 Web UI、插件、session branch、游戏对比；其“Harness 版本更好”的结论是视频作者标为“主观实测结论”，不可泛化。

### 英文 / 国际

* 官方 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 是比 Issues 更实际的支持面（官方 repo Issues 页面显示 “Issue creation is restricted”）。讨论页可见并发的真实故障主题，如 > “Session restore fails after hard-closing browser”、> “workflow tool clips its result to 50,000 chars … rest is lost”、> “OpenAI strict mode … unrecoverable … loop”。这只证明有人报告，未等于 maintainer 已确认或修复。
* [Reddit 安装问题帖](https://www.reddit.com/r/DeepSeek/comments/1vudb3c/downloading_harness_problem/)报告 `npx` 下载“freeze”；回复称改 `bunx` 有效。原文：> “Had the same problem, and just used bunx and worked”。这是小样本 workaround，**UNVERIFIED 根因**，不可当官方建议。
* Reddit [DeepDeck 展示](https://www.reddit.com/r/SideProject/comments/1vxybmp/i_built_a_hacker_news_reader_users_can_modify/) 是一个可见的非官方实际应用：作者明确写 > “DeepDeck is based on DeepSeek Harness, but it is not an official DeepSeek product”，并描述 agent 改本地 source、build、hot reload 的 loop；这是作者自报成功示例，未独立审计。
* X 与 Hacker News：以精确词 “DeepSeek Harness” 检索，**此处是空白**——本轮未取得足以逐字引述、可归因的相关原帖，故不拿搜索摘要充数。

## 失败与坑

1. **预览版破坏性变更。** 官方原文：> “THERE WILL BE COMPATIBILITY-BREAKING CHANGES.” [README](https://github.com/deepseek-ai/deepseek-harness)。锁定 dsh/插件版本并保存 `--dump-config`，否则复现不了。
2. **安装通道/产物。** 主 evolve 的两个公开 issue 就是 git 安装缺 build artifact；优先按该仓库要求运行 `scripts/build.sh` 或用已验证 tarball，别假定 git spec 有 `prepare`。[Issues](https://github.com/william-jin-cmu/dsh-evolve/issues)
3. **工具集变动会打断 prompt cache。** 主 evolve README 明示：> “中途改工具集会使该 session 的 prompt cache 前缀失效”。这是成本提示；“每 step 工具重算”是其项目的实现主张，未以 DSH 官方通用 API 文档独立证实，故对其他插件标 `UNVERIFIED`。[README](https://github.com/william-jin-cmu/dsh-evolve)
4. **任意 ESM = 同权限代码，不是受控演化。** 主 evolve README 的原文：> “真实模块加载、无沙箱（与主 harness 同权限）”。只适合可信本机；必须加 source review、allowlist、签名/哈希、权限最小化和回滚，而不该让模型默默常驻写入。
5. **workflow 的资源/安全边界。** worker 引擎有 `maxConcurrentAgents`、`maxTotalAgents`（默认 1000）等背压参数，却明确不是安全 sandbox。[工作流 worker](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workflow/workflow-worker-thread/README.md) 原文：> “genuinely untrusted scripts require a separate process or container engine.”
6. **UI 与 session 恢复仍会翻车。** 官方 Discussions 的具体报告包括浏览器硬关后 `SessionAlreadyOwnedError`、问答卡不显示而 turn 挂起；报告不等于已修复。 [Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)；[问答卡报告](https://github.com/deepseek-ai/deepseek-harness/discussions/1554) 原文：> “turn hangs with no timeout”。

## 对 pi 的可抄点

这里的“可抄”是设计推断，不是说 Pi/DSH API 可以直接互换。

1. **把热改造做成可逆 transaction，而不是仅 `/reload`。** DSH Fiber 的 dispose 有结构化清理和 reverse-order disposer；Pi 文档说明 `/reload` 会 shutdown 后重启 resources，且 “Code after `await ctx.reload()` still runs from the pre-reload version”。[DSH Fiber](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/fiber)、[Pi extension docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)。推断：Pi 可加 evolution manifest（source hash/revision/status/rollback）、先 validate/dry-run、原子切 active revision、失败回滚；不要让 reload 后的旧 frame 继续写状态。
2. **动态工具需有 ownership + disposer。** Pi 文档已说 `pi.registerTool()` 可在 startup 后调用、且 “New tools are refreshed immediately in the same session”；DSH 的强项是 tools/listeners/services 都由 fiber 拥有并一起 dispose。 [Pi docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[DSH Fiber](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/fiber)。推断：Pi 加 `registerTool()` 的反注册句柄/extension generation，并在 reload、失败或 remove 时撤销；否则自生工具只能加不能净删。
3. **把“工具、hook、timer、prompt policy”分型。** 主 evolve 的有效洞察是 pull tool 不适合“每次/自动/主动”，它分别用 event hook/timer/prompt section；其 README 明言 “工具是 pull”。[主 evolve README](https://github.com/william-jin-cmu/dsh-evolve)。推断：Pi evolution schema 应有 capability kind，timer 必须有显式 target scope、rate limit、kill switch，避免其 README 已演示的进程级广播误伤其他 session。
4. **维护真实实验闭环。** 知乎讨论指出“能调整”不等于“能判断改进”；另一个 evolve 的公开 issue 已显示 2-gram retrieval false positive。[知乎](https://zhuanlan.zhihu.com/p/2073839461658636357)、[issue list](https://github.com/chenzheshushi-commits/dsh-evolve/issues)。推断：Pi 应记录基线 task、变更、离线 eval、成本/成功率、回滚准则；没有独立 eval 就只能称 customization，不能称 RSI。
5. **兼容性与信任边界必须显式。** DSH 是 preview、主 evolve 同权限 ESM、Pi 又允许 runtime immediate tool registration；三者组合的安全结论是推断：默认应“提议→展示 diff/权限→用户批准→启用”，并对持久化、联网、shell、定时唤醒分别授权，而非一个 `evolve_add` 全放行。 [DSH README](https://github.com/deepseek-ai/deepseek-harness)、[主 evolve README](https://github.com/william-jin-cmu/dsh-evolve)、[Pi docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)。


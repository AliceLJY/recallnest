# RecallNest 第二轮代码体检：改进建议（2026-11-01）

> 只出建议，不改代码。基于 main `bf94f72`（#40 合并、基线 3171 之后）。
> 上一轮体检文件 `docs/audits/2026-10-17-improvement-proposals.md` 不在仓库里（`git log --all` 查不到），本轮按任务说明里列的「已处理 / 正在做 / 已定不做」清单避让。

## 0. 环境与基线

| 项 | 结果 |
|---|---|
| `bun test`（云端容器，root，bun 1.4.4，`bun install --frozen-lockfile` 之后；`config.json` 按 CI 从 example 拷贝） | **3171 pass / 0 fail / 222 files**，10098 expect，140.5 s |
| `bunx tsc --noEmit -p tsconfig.json` | **0 错**（exit 0） |
| 与 root 相关的红 | **没有**。上一轮记的 `sessions-sweep-wrapper.test.ts` 2 红已由 #36 修掉，这次 root 下全绿 |
| 注意 | 容器一开始没有 `node_modules`，第一次跑全量满屏 `Cannot find package 'openai'`；装依赖后才是上面的数。新 session 先 `bun install` |

一次性探查改动：全部在 scratchpad 的仓库副本里做，仓库本身没改（还原后 `cmp` 逐字节一致）。探查脚本只读源码函数、用临时目录，不碰真实数据。

## 1. 摘要表（按 价值 ÷ 风险 排序）

| # | 标题 | 类别 | 严重度 | 改动范围 | 碰核心写路径 | 仓库内可做完、测试当裁判 |
|---|---|---|---|---|---|---|
| 1 | checkpoint 脱敏被「sk- 小写连字符名」保护规则绕过，口令 / key 明文落盘 | 安全 / 正确性 | **P1** | 2 文件 | checkpoint 落盘（非 memories） | 是 |
| 2 | 检索尺子修成能用：expectAny 按「全部同义词的比例」计分 + 死掉的 cc 前缀 + canary 缺目标存活预检 | 评测 | **P1** | eval 2 个 fixture + `src/eval.ts` + 1 测试 | 否 | 是（打分逻辑）；fixture 内容要 owner 在生产快照上核 |
| 3 | `checkpoint_session` 工具描述与文档说「不进长期记忆」，实际默认镜像进 memories | 文档 / 模型可见描述 | **P1** | 1 源文件（工具描述字符串）+ 4 文档 | 否 | 是（描述是字符串，`contracts.test` 兜形状） |
| 4 | 会话扫描：单场异常中断整轮（已付 LLM 费、后面的场全不处理、游标不存） | 健壮性 | P2 | 1 文件 | 否（账本） | 是 |
| 5 | 会话扫描：退避标记 `llmRetryAt` 在两条路径上永不清，该场每轮重读并写一行日志 | 正确性 / 日志膨胀 | P2 | 1 文件 | 否 | 是（已有一次性复现） |
| 6 | BM25 补偿那一路的 scope / 排除 scope / active / 时间窗过滤没有任何测试钉住 | 测试缺口 | P2 | 1 测试文件 | 否 | 是（只加测试） |
| 7 | 决定归属复判失败静默回落关键词判法，账本上看不出 | 可观测性 | P2 | 3–4 文件 | 否 | 是 |
| 8 | 噪声过滤收窄后，写入端放进了不带逗号的助手否认句与「元数据头 / 时间戳 + 一个字回复」 | 写入质量 | P2 | 2 文件 | 是（admission 闸） | 是 |
| 9 | 锁不可重入但嵌套时不报错，而是等满超时再报「被自己 pid 占着」 | 健壮性 / 可诊断性 | P2 | 1–2 文件 | 是（store-write 外层） | 是 |
| 10 | 「importance 压过相关度」「source diversity 挤掉强命中」的快照重放方案（深化，不是改法） | 检索质量 / 评测 | P2 | 1 个可选 knob + eval 脚本 | 默认值逐字节不变 | 部分（重放要 owner 的快照） |
| 11 | `MCP_TIER` 默认 advanced 只注册 30 个工具，README / SKILL 说 44 个且不分层 | 文档 | P2 | 3 文档 | 否 | 是 |
| 12 | 死代码清理：`RECALLNEST_LLM_CONSOLIDATION` 整条链、retroactive-boost 等约 900 行 | 维护 | P2 | 删 3–4 文件 + 若干导出 | 否 | 是（删后 tsc + 全量） |
| 13 | 文档漂移：HTTP 端点、architecture.md、env-config 文件头、§5 漏记的开关、过期注释 | 文档 | P2 | 6–8 文件 | 否 | 部分 |
| 14 | `[low-confidence]` BM25 补偿条目分数下限 ≥0.5，「同一分数地板」名存实亡 | 检索质量 | P2 | 1 文件 | 否 | 是（但要配 #2 / #10 的尺子判好坏） |
| 15 | 本地 UI `/pin` 的 `profile` 不校验、`as any` 直通落盘 | 输入校验 | P2 | 1 文件 | 否 | 是 |

macOS 要 owner 补验的锁相关项单列在第 3 节（云端只有 Linux，CI 也只有 `ubuntu-latest`）。

---

## 2. 逐条

### #1 checkpoint 脱敏被「sk- 小写连字符名」保护规则绕过（P1，安全）

**证据**
- `src/session-store.ts:58-61` 的 `CHECKPOINT_PROTECTED_NAMES` 第二条 `/(?<![A-Za-z0-9])sk(?:-[a-z]{2,20}){2,}(?![A-Za-z0-9_-])/g`，在通用脱敏规则跑之前先把这类串遮起来、跑完再放回，所以 `sensitive_assignment` / `Bearer` 规则看不到它。
- 探查（直接调 `redactCheckpointRecord`，scratchpad 脚本）：

```
"db password=sk-correct-horse-battery staple" -> "db password=sk-correct-horse-battery staple"
"api_key=sk-test-only-abcdefghijklmnop"       -> "api_key=sk-test-only-abcdefghijklmnop"
"Authorization: Bearer sk-abc-def-ghi-jkl"    -> "Authorization: Bearer sk-abc-def-ghi-jkl"
"api_key=sk-Abc123XyzRandomTail9876"          -> "api_key=[REDACTED:api_key]"     ← 对照：混大小写数字的仍被脱
```
- 镜像那一路用的是不带保护名的 `redactSecrets`，三条都会被脱——**同一段文字，镜像里脱了、落盘 JSON 里没脱**。
- 「改坏不红」：把保护规则改成「紧跟 `=`、`:`、`Bearer ` 之后不保护」，三条都被脱，`checkpoint-redaction.test.ts` 仍 21/21 绿——这个情形没有测试钉在任何一边。

**失败场景**：人起的口令、测试 key、passphrase 恰好是全小写连字符形状，进 `data/session-checkpoints/*.json` 明文，`latest_checkpoint` / `resume_context` 原样吐回给 agent。

**建议改法**：保护名只在「不紧跟赋值号 / `Bearer` / URI userinfo」时生效（负向后顾 `(?<![=:]\s*)(?<!Bearer\s+)`），或者放回保护名之后对赋值 / Bearer 规则再跑一遍。把上面三条加进 `checkpoint-redaction.test.ts`，另加一条「`sk-checkpoint-redaction-design` 作为文件名照旧保留」防误伤回归。

**范围**：`src/session-store.ts`、`src/__tests__/checkpoint-redaction.test.ts`。一个仓库内做完，测试当裁判。#40 的修复按 CLAUDE.md 记载「未经 reviewer 复核」，这条正好落在复核空白里。

---

### #2 检索尺子：最小代价修成能用（P1，评测）

任务说明里「20 例 19 败、canary 12 例 6 过」，主因不是检索，是尺子本身。

**证据 A：`expectAny` 按「命中词数 / 全部同义词数」计分，fixture 却是按「任一命中」写的。**
- `src/eval.ts:258-261` `scoreExpectation = matched.length / expected.length × weight`；`:272-290` 归一化后 `score = norm × 0.9 + 0.1`，及格线 0.7。
- `eval/cases.json` 的 notes 写着「Use expectAny with synonyms to avoid penalizing paraphrase」「Loosened from expectAll to expectAny with synonyms」——作者的意图是 OR；但在比例计分下，**多写同义词反而更难过**。各 case 列了 3–13 个同义词。
- 探查（直接调 `scoreRetrievalCase`，结果构造成「1 条记忆，scope 取 fixture 里第一个非 cc 前缀」）：

| 情形 | 20 例里能过的 |
|---|---|
| 这 1 条正文里**含有全部** expectAny 词 | 20 / 20（15 例恰好卡在 0.70） |
| 这 1 条正文里**只含 1 个** expectAny 词（即「找到了对的那条」） | **0 / 20**（分数 0.15–0.45） |

- `expectScopePrefixes` 同样按比例：20 例全带 `cc`（15 例只有 `cc`），而 cc 前缀的对话切片 10-06 已删、默认不再入库，这一维对 15 例永远是 0。前缀列多个时也要求结果里**每个**前缀都出现，同样不是 any 语义。
- `src/__tests__/retrieval-eval.test.ts:36-43` 把「4 个里命中 2 个才及格」写成了契约——当时修的是「白送 expectAll 0.3」，比例语义是顺带钉住的，不是专门论证过的选择。

**证据 B：canary 按 id 前缀判目标，没有「目标还在不在库里」的预检。** `scoreCanaryCase`（`src/eval.ts:315-`）对缺失目标直接给 0。10-06 / 10-05 删过 1.8 万行（对话切片、无层级摘要、AGY 导入），canary 的 12 个目标 id 有几个已不在库里，云端无数据没法核，但分数分不出「目标死了」与「检索没找到」。`src/known-item-eval.ts` 已经有现成写法（宿主不存在 / 非 active / archived 剔除并记原因）。

**附带**：`runRetrievalEval` / `runCanaryEval`（`src/eval.ts:831-836`、`872-877`）用 `source: "auto-recall"` 但没传 `trivialQueryGate: false`，测的是自动召回那道闸之后的路径，不是 `search_memory` 路径。现有 32 条查询探查过都不会被闸掉（0/20、0/12），属潜在偏差，顺手对齐 known-item 的写法。

**建议改法（最小代价，三步，一个 PR）**
1. `expectAny` 改成真 any：命中 ≥1 即该维满分（或 `min(1, matched / min(expected, 2))` 二选一，owner 定）；`expectScopePrefixes` 同样改成「任一前缀出现」。同步改 `retrieval-eval.test.ts` 那两条比例用例，并加反向用例「13 个同义词只中 1 个仍及格」。
2. fixture 去掉 `cc` 前缀（只剩 cc 的 15 例改成 `memory` / `project:` 或删掉该维）。这一步是内容判断，**要 owner 对着生产快照逐条确认**期望 scope；云端只能做机械删除。
3. canary 加预检：跑前对 `targets` / `expectOrder` / `hardNegatives` 逐个 `getById`，不在 / 非 active 的单列「fixture 过期」并从分母剔除，报告里分开计数。加 `trivialQueryGate: false`。

**判据**：改完后同一个快照跑一遍，报告要能把每个失败归到「fixture 过期」「scope 期望不对」「真没找到」三类之一；只有第三类计入检索质量。注意这仍不是「答案质量」公共尺子（不做，见已定方向 12），只是让现有回归尺子能报真话。

**范围**：`src/eval.ts`、`eval/cases.json`、`eval/cases-canary.json`、`src/__tests__/retrieval-eval.test.ts`（+ canary 测试）。打分逻辑仓库内可做完、测试当裁判；fixture 内容需 owner 本机。

---

### #3 `checkpoint_session` 描述说「不污染长期记忆」，实际默认镜像进 memories（P1，模型可见文档）

**证据**
- 模型每次都读到的工具描述 `src/mcp-tools-core.ts:182`：「…without polluting durable memory」。
- `README.md:419`「outside durable memory」；`docs/api-reference.md:802`、`:812`（示例就是 "Keep checkpoints out of LanceDB"）；`docs/memory-boundary-contract.md:29` session 层「Can be mirrored into LanceDB? → No, not as durable memory」、`:56-62`「not merged into one store」。
- 代码：`src/checkpoint-mirror.ts:1-9` 每次保存同步镜像进 `memories` 表 scope `checkpoint`，`mcp-tools-core.ts:216`、`api-server.ts:457` 两个入口都调；`RECALLNEST_CHECKPOINT_MIRROR` 默认开；不带 scope 的搜索能搜到（CLAUDE.md §5 自己写着）。
- checkpoint 落盘前脱敏（#40）文档里也只字未提，api-reference 只说去 git status。

**为什么 P1**：工具描述是 agent 选工具时的唯一依据。「不进记忆」会让 agent 把本不想长期留的东西写进 checkpoint；镜像有脱敏，但见 #1，落盘这边有洞。

**建议改法**：工具描述改为「保存当前工作状态；默认同时镜像一份到 scope `checkpoint`（可用 `RECALLNEST_CHECKPOINT_MIRROR=off` 或 `data/checkpoint-mirror.off` 关），落盘与镜像前都做凭证脱敏」。上述四份文档同步；boundary-contract 那一行改成「Yes, mirrored into scope `checkpoint`, excluded from patterns / resume」。

**范围**：1 个源文件里的字符串 + 4 份文档。按 CLAUDE.md §2「改 tool schema 前先确认调用方兼容性」——这里只改 description，不改 inputSchema，调用方不受影响。

---

### #4 会话扫描：单场异常中断整轮（P2）

**证据**
- `src/sessions-sweep-run.ts:237-371` 的逐文件循环里只有 `decide()` 包了 try/catch（`:243-249`）；之后的 `buildLedger`（LLM）、`commitLedger`（写入者标记读不了时在 `:491`、`:499`、`:522` 抛）、`stateStore.save` 抛错都直接冒出 `runSweep`。
- 一次性复现（仓库副本，把 `.writer-host` 换成目录制造读错误）：输出 `ERR 账本目录归 （标记文件读不了：EISDIR）…`，`llmCalls 1`、`states []`、心跳里 `runningSince` 还挂着——第二场没处理、游标没存、签名索引没重建。
- 同文件 `:550` 附近注释自述这个标记读错误 10-23、10-27 夜里真发生过。

**失败场景**：一次瞬时读错误白付一次 LLM、整轮作废；一场「每次都抛」的会话按 mtime 升序排在前面时，会让它之后的所有会话每轮都处理不到（饿死）。

**建议改法**：每场的「生成 → 提交 → 存游标」包一层 try/catch：记日志、计数进心跳（doctor 可报黄）、给该场设退避，继续下一场；写入者标记在轮首读一次，读不了整轮早退（不先花 LLM 钱）。

**范围**：`src/sessions-sweep-run.ts`（+ doctor 读心跳计数可选）。测试：`sessions-sweep-run.test.ts` 加「第一场 commit 抛错、第二场照常出账本、心跳 runningSince 清掉」。

---

### #5 会话扫描：`llmRetryAt` 在两条路径上永不清（P2）

**证据**
- 清退避只有一处：`src/sessions-sweep-run.ts:350-353`，条件是本轮真生成了账本。两条路径会先把决定改成 `up-to-date`、绕过它：
  - 当场账本已覆盖（`:255-258` 的 `keepAgentUpto`）；
  - 收工命令 `writeSessionLedgerNow`（`:655`）用 `{ ...state, … }` 原样带着旧的 `llmRetryAt`。
- 之后 `decide()` 的 mtime 快路径条件里有 `!state.llmRetryAt`（`src/sessions-sweep.ts:270`），永远走不进，每轮都全量解析这场转录；产出的 `up-to-date / 收工账本之后没有新的用户发言…` 不在 `:367` 的 quiet 集合里，每轮一行。
- 一次性复现（副本里的临时测试）：LLM 429 一次 → `writeSessionLedgerNow` 带正文 → 再扫 4 轮：最终 state 仍是 `{"llmRetryAt":"2026-10-23T12:30:00.000Z", …}`，sweep 日志 5 行。

**失败场景**：LLM 失败过一次、之后用户收工写了账本的会话，每 10 分钟被整份重读一次并追加日志——和 10-31 那次 353 MB 是同一类膨胀，只是慢。

**建议改法**：`keepAgentUpto` 分支和 `writeSessionLedgerNow` 的保存里一并清 `llmRetryAt` / `llmFailCount`；quiet 集合加上这条 reason（或判「up-to-date 且 processedUpto 没变」）。

**范围**：`src/sessions-sweep-run.ts`。测试：上述复现直接转成用例。

---

### #6 BM25 补偿这一路的过滤没有测试钉住（P2，只加测试）

**证据**：`src/retriever.ts:1075-1117` `collectExactTokenSupplements` 现在是对的（scope / exclude 透传到 `store.bm25Search` SQL + 应用层双重过滤，`:1091` 排掉非 active）。但「改坏不红」：
- 本轮亲手在副本里把 `:1087` 的 `scopeFilter`、`excludeScopes` 换成 `undefined`：`bun test src/__tests__/retriever*` **34 pass / 0 fail**；另一位审阅在同一改坏下跑全量 3171 / 0 fail。还原后与仓库 `cmp` 一致。
- 同法验证过：去掉 `isActiveMemory`、去掉时间窗、去掉 `hasId` 幽灵行检查、名额 3 改 20，`retriever-exact-token-bm25.test.ts` + `entity-resolver.test.ts` 23/23 全绿。对照组（换回原始 BM25 分、去掉与向量命中去重、回退别名正则）分别 3 / 1 / 3 红，说明测试是活的、只是没覆盖过滤。

**失败场景**：重构时漏传 scope，含文件名 / snake_case 词的查询就会把别的 scope、包括被排除的 `checkpoint` 镜像条目补进结果，没有任何东西变红。

**建议改法**：在 `retriever-exact-token-bm25.test.ts` 加 4 条：只靠 BM25 命中、含精确 token 的行分别放在（a）别的 scope（b）被排除的 scope（c）`archived` / `superseded`（d）时间窗外，各自不得出现在结果里。每条配上述对应的改坏方式做反向验证。

**范围**：1 个测试文件，零生产代码。风险最低。

---

### #7 决定归属复判失败时静默回落关键词判法（P2，可观测性）

**证据**
- `judgeDecisionAttribution` / `requote` 吞掉所有错误返回 null / 0（`src/ledger-attribution.ts:166-168`、`:188-190`），`rejudgeDecisions` 随即回落关键词判法（`src/session-ledger.ts:506-507`、`:595`）。
- frontmatter（`:652-669`）、`llmFailures`、心跳、doctor 都不记这次回落；账本照写 `generator: llm`。
- CLAUDE.md 10-31 条目：关键词判法在 32 条上错 17 条，正是换 LLM 复判的原因。

**失败场景**：复判这一次调用持续 429 / 超时（10-23 qwen-turbo 下线那种），所有账本悄悄退回 17/32 的判法，从账本和 doctor 都看不出来。

**建议改法**：复判返回失败原因；frontmatter 加 `attribution: llm | keyword-fallback`；心跳计数回落次数，doctor 超过阈值报黄。

**范围**：`ledger-attribution.ts`、`session-ledger.ts`、`sessions-sweep-run.ts`、`doctor.ts`。测试：假 LLM 在 `ATTRIBUTION_SYSTEM_PROMPT` 上抛错，断言 frontmatter 与心跳。

---

### #8 噪声过滤收窄后，写入端放进了几类该挡的（P2）

**证据**
- 收窄同时作用于写入：`isNoise` 被 `admission-control.ts:145`（所有 `persistMemory`：`store_memory` / `batch_store` / `/v1/store` / `/v1/capture`）、`capture-heuristic.ts:54`（自动捕获）、`ingest.ts:947,1046`、`memory-promotion.ts:144` 共用。
- 新旧 `isNoise` 对照（副本探查），**原来判噪声、现在放行**：
  - `抱歉我不太确定你说的是哪个项目`、`其实我不确定这个配置在哪里` —— `noise-filter.ts:24` 新规则要求开头短语后跟逗号；
  - `---\n{"chat_id":"123"}\n---\n好的`（元数据头 + 回复，`:83`）；
  - `[2026-10-05T16:38:03 GMT+8]\n好的`、`2026-10-05T16:38:03Z ok`（时间戳 + 短回复）；
  - `新会话，先读一下上次的进度`。
- 仍判噪声（没退化）：`嗯，我不确定`、`Sorry, 我不太确定`、`ok!!!`。
- 「改坏不红」：把 `:24` 换成下面的修法，noise + admission 测试 109/109 仍绿——不带逗号的否认句两边都没有测试。

**失败场景**：显式写入与自动捕获里混进助手的否认句与「一个字回复」碎片。对话原文入库 10-06 已默认关，影响面限于显式写入与 auto-capture，所以 P2。

**建议改法**：`:24` 改为 `/^[^，,。！？!?：:\n]{0,6}[，,]?\s*我不(太)?确定(?!的)/`（排除 `：:` 是为了不误伤「规则：遇到我不确定就…」这类长规则文本）；可选：「元数据块 / 时间戳 + 本身是噪声的短回复」整体判噪声。上面 5 条进 `noise-filter.test.ts`。建议照 #38 的做法再对生产库跑一次新旧 `isNoise` 对照（救回 / 新误判数）作为本机门。

**范围**：`src/noise-filter.ts` + 测试；碰 admission 闸，但只收紧到 #38 之前的范围。

---

### #9 锁不可重入，嵌套时等满超时才报、报的还是「被自己占着」（P2）

**证据**
- `src/distill-lock.ts:199` `if (heldLocks.has(lockPath)) return false;` —— 同进程再拿同一把锁一律当「被别人占着」，`withLock(onBusy:"wait")` 于是轮询到超时。
- 探查（scratchpad 锁目录）：

```
withWriteLock("store-write", () => withWriteLock("store-write", …))
→ after 1527 ms: LockTimeoutError lock 'store-write' timed out after 1500ms
  (held by pid 18269, held 2 s (max hold 600 s)) | own pid 18269
```
  生产里 store-write 的等待预算是 30 s（`store-write-budget.ts:14`），即嵌套一次 = 该次写入卡 30 s 后失败，报错把人引向「另一个进程卡住了」。
- 目前靠注释约束（`store.ts` `replaceWithArchivedVersion` 文档：「plan 里也不能调用会再拿 store-write 的公有方法（锁不可重入，会等自己到超时）」），没有守卫。`store-write-lock-opts.test.ts` 管的是外层等待预算，不管同 key 嵌套。

**建议改法**：`withLock` 用 `AsyncLocalStorage` 记录当前异步调用链已持有的 key；同链再拿同 key 立即抛 `ReentrantLockError`（不影响同进程**并发**的两个请求——它们不在同一条异步链上，照旧排队）。顺带把 `LockTimeoutError` 在「holder pid === 本进程」时的措辞改成「本进程另一处持有」。

**范围**：`src/distill-lock.ts` + 测试（嵌套立刻抛、并发照旧串行、不同 key 嵌套不受影响）。行为上只把「30 s 后超时」提前成「立即报错」，不改变任何成功路径。

---

### #10 「importance 压过相关度」「source diversity 挤掉强命中」的快照重放方案（P2，深化）

不重复 owner 已有的证据，只补「怎么在快照上重放」需要的、仓库里现成或差一步的东西。

**现状（只读核对）**
- importance：`src/retriever.ts:2090-2100` `applyImportanceWeight` 的 `baseWeight = 0.5` **写死在函数里**，config 调不了——要重放就得先有一个旋钮。
- source diversity：`DEFAULT_RETRIEVAL_CONFIG.sourceDiversity: 1`（`:286`），可经 `config.json` 的 `retrieval` 段覆盖（`runtime-config.ts:188`），**不用改代码就能关**。
  - 注释与代码不符：`:147-151` 写「0 = disabled (default). Recommended: 0.5 (moderate diversity)」，但默认是 1，而且代码只看 `> 0`（`:1655`），0.5 与 1 行为完全相同——没有「强度」这回事。
  - `applySourceDiversity`（`:510-551`）轮转之后**不按分数重排**：每个 scope 的第 1 名先占位、按 scope 最好分排序，然后才按全局分数补位。所以第 1 个 scope 的第 2 强命中会排在第 5 个 scope 的第 1 名（可能弱得多）之后；只在候选数 > limit 且 ≥3 个 scope 时触发。
- 现成的重放工具：`eval/known-item.ts` 支持 `--db <快照> --now <冻结时钟>` 与 `compare`，报告只含 id 与数字；它把 `retriever.getConfig()` 里的 `sourceDiversity` 等写进报告头（`:153-171`）。

**建议方案**
1. 加一个 `importanceBaseWeight` 检索配置项，默认 0.5、不设时逐字节不变（照 `RECALLNEST_POPULARITY_RANKING` 切默认前那种「默认不变 + 测试钉默认」写法）。这是唯一需要碰生产代码的一步。
2. 在同一快照、同一冻结时钟上跑四臂：`{sourceDiversity: 1, 0} × {importanceBaseWeight: 0.5, 0.8}`，用 `known-item.ts compare` 逐条列救回 / 掉出。
3. known-item 是「查询 = trigger 原文」的上限情形，importance 的影响会被余弦 ≈1 掩盖；所以第二把尺子用 #2 修好之后的 canary（目标 id 已预检存活）。**#10 依赖 #2**。
4. 判据先写死再跑：例如「known-item 第 1 名占比不降 + canary 第一下命中不降，且至少一臂在某把尺子上净救回」，避免跑完再挑。

**范围**：生产代码 1 处（默认不变的旋钮）+ 注释更正；重放本身在 owner 本机快照上做。

---

### #11 工具分层：README / SKILL 说 44 个，默认只注册 30 个（P2）

**证据**：`src/env-config.ts:195-196` `mcpTier` 默认 `"advanced"`；`src/mcp-server.ts:98-104` `shouldRegisterTool` 在 advanced 下丢掉 14 个 governance 工具（`workflow_observe/health/evidence`、`list_conflicts`、`resolve_conflict`、`audit_conflicts`、`escalate_conflicts`、`list/clean_dirty_briefs`、`consolidate_memories`、`promote_scan`、`promote_synthesis`、`scan_skill_promotions`、`manage_alias`）。`README.md:136`、`:402`「MCP Tools (44 tools)」、`README_CN.md:129`、`SKILL.md:255` 都说 44，表格不标层级；用户文档里没有任何地方提 `RECALLNEST_MCP_TIER`。（`mcp-server.ts:10-14` 的注释本身是对的；44 这个总数与 `contracts.test.ts:211` 一致。）

**失败场景**：按 README 调 `list_conflicts` / `workflow_observe`，工具不存在。

**建议改法**：表格加 Tier 列，写明「默认 30 个；`RECALLNEST_MCP_TIER=full` 为 44 个」。纯文档。

---

### #12 死代码清理（P2，维护）

逐个 grep 过 `src/ scripts/ eval/ integrations/ bin/ connectors/`，无动态 import、无 cli 引用：

| 导出 / 模块 | 位置 | 约行数 | 为什么是死的 |
|---|---|---|---|
| `auto-consolidation.ts` 整个模块 | `src/auto-consolidation.ts` | 138 | 只有测试 import；`version-manager.ts:108-113` 注释自认生产零 import |
| `llm-consolidation.ts` 整个模块 | `src/llm-consolidation.ts` | 169 | 只被上面那个死模块 import |
| `createVersionGroup` | `src/version-manager.ts:122` | 49 | 唯一调用方是 `llm-consolidation.ts` |
| `RECALLNEST_LLM_CONSOLIDATION` 访问器 | `src/env-config.ts:89` | — | 只喂上面这条死链，设了也没效果 |
| `retroactive-boost.ts` 整个模块 | `src/retroactive-boost.ts` | 159 | 只有测试 import；但 `memory-utility.ts:15` 注释说「STC 的 retroactive-boost 在改它（importance）」——与事实不符 |
| `ingestGenericText` | `src/ingest.ts:2219` | ~124 | 全仓零引用（含测试） |
| `acceptPredictedReminder` / `demotePredictedReminder` | `src/prospective-memory.ts:281,317` | ~63 | 只有测试；无工具 / CLI |
| `readPinAsset`、`homeostasisAdjustedThresholds`、`CATEGORY_MERGE_STRATEGY`、`logError` | 各处 | 合计 ~45 | 全仓零引用 |

**建议**：第一批只删「全仓零引用」与 `LLM_CONSOLIDATION` 整条链（链上的测试一并删，基线会降——按 §6「基线只能涨」，需要 owner 明确批准这次下降并在基线行写明原因）。`retroactive-boost`、预测提醒那两个是「未接线的功能」，删还是接是产品决定，单列给 owner。顺带改 `memory-utility.ts:15` 那句注释。

**范围**：删 3–4 文件 + 若干导出 + 对应测试；`tsc --noEmit` + 全量当裁判。

---

### #13 文档漂移与过期注释（P2）

都已逐条两边对过 file:line：
- **HTTP 端点**：`api-server.ts:677-701` 有 21 个路由；`README.md:454` 写 21 个、表里只有 20 行，漏 `/v1/auto-recall`（`README_CN.md:431` 同）。`docs/api-reference.md` 没有 `GET /v1/lint` 小节，还留着未实现的 `/v1/consolidate`、`/v1/gaps`（`:1246-1262`），503 行（`:1281`）漏了 `/v1/checkpoint` 等锁超时也回 503（`api-server.ts:464`）。
- **`docs/architecture.md`**：把 `/v1/consolidate`、`/v1/gaps`、「Gap Detector」画成在用（`:37-38`、`:65-69`），只列 7 个工具，列出代码里不存在的 `access_log`、`search_log` 表（`:83-84`），漏了真有的 `kg_triples`、`memory_triggers`；入库图（`:94-104`）还画着对话原文入库（10-06 起默认关）。
- **`src/env-config.ts` 文件头**：`:4` 说是所有 `RECALLNEST_*` 的唯一来源，但 `:30-35` 的例外清单漏了 `recall-gate.ts`、`noise-prototype-bank.ts`（它们经参数读 `env.RECALLNEST_*`，绕过了 `env-config-invariant.test.ts:49` 的模式）；`:11` 说布尔开关用 `=== "true"`，但 `triggerRecall`（`:44`）、`triggerLengthExempt` 用的是 `!== "false"`。
- **CLAUDE.md §5 漏记的会改行为的开关**：`RECALLNEST_RECALL_GATE`（默认 observe）、`RECALLNEST_NOISE_PROTOTYPE`（默认 shadow，会在数据目录存学到的噪声表）、`LAYER_ADMISSION(_MIN)`、`USAGE_DECAY`、`ERROR_SIGNATURE_BOOST`、`CORE_SUMMARY`、`SYNTHESIZE`、trigger 调参一组。§5 里写了的 12 个全都还在被读。
- **过期注释**：`src/sessions-sweep.ts:4-5`「P0 影子模式…本文件里非影子路径一律抛错」——P1 正式模式已上线（`cli.ts:3187-3234`），文件里没有任何 throw；`sessions-sweep-run.ts:4-7` 写对了。`src/mcp-tool-deps.ts:4`「43 个 registerTool」实际 44。`src/mcp-server.ts:3-7`「search your indexed conversations」——对话原文已默认不入库。`src/retriever.ts:147-151` sourceDiversity 注释（见 #10）。

**建议**：一个纯文档 PR；CLAUDE.md 那部分 owner 自己改（本任务不碰）。`env-config-invariant.test.ts` 的模式可顺手扩到「经参数传入的 env 对象」，那部分可测。

---

### #14 `[low-confidence]` BM25 补偿条目的分数下限 ≥0.5（P2）

**证据**：补偿条目的向量分 `1/(1+(1−cos))`，cos ≥0 时 ≥0.5（`retriever.ts:790`）；BM25 分是 sigmoid、下限 0.5（`store.ts:810`）；两者加权混合（`retriever.ts:1106`）后，任何只要含那个 token 的行起步 ≥0.5，远高于 `hardMinScore` 0.35。算例：cos 0.3、BM25 0.88 的无关行混合约 0.676，压过 cos ≤0.52 的真答案；每条精确 token 查询最多补进 3 条。向量路径本身的分也是同一映射（下限 0.333），所以这是继承下来的分数尺度问题，#39 只是让它在补偿路径上也成立。

**为什么 low-confidence**：没有在真实库上量过补偿条目把真答案挤下去的频率；#39 合并时 eval / canary 逐例与 main 相同，说明至少在那两把（有缺陷的）尺子上没有可见回退。

**建议**：等 #2 修好尺子后，在快照上量「补偿条目进前 3 且不是目标」的比例；若显著，再考虑给补偿条目单独设余弦门槛（向量路径的最低分 + 余量）。现在不建议直接改。

---

### #15 本地 UI `/pin` 的 `profile` 不校验（P2）

**证据**：`src/ui-server.ts:341` `readOptionalString(body.profile) as any || "default"` 直通 `pinMemory`，最终写进 pin JSON 与主表索引副本（`memory-assets.ts:160,465`）。`retrieval-profiles.ts:108` 有现成的 `normalizeRetrievalProfile` 没用。这是 #43 之后剩下的 65 处显式 `any` 里唯一藏着真问题的一处（其余：`ingest.ts` 29 处转录 JSON 解析与 `catch (err: any)`、`store.ts` 13 处 LanceDB 行、`doctor.ts` 9、`cli.ts` 7 等；`forget-engine.ts:417` 的 `"archived" as any` 多余但无害；`api-server.ts:67` 的请求体 `Record<string, any>` 靠各 handler 自己校验）。UI 只监听 loopback，影响小。

**建议**：换成 `normalizeRetrievalProfile(...)`，加一条「非法 profile 落成 default」的用例。1 文件。

---

## 3. 锁（flock，10-18 起）：查过、没问题的，与要 owner 在 macOS 补验的

**查过、没发现问题**
- 进程被 SIGKILL：内核随 fd 关闭释放 flock；锁文件残留（release 时才 unlink），下一个拿锁的照常拿到——`parseFlockBody` 能解析就不走「老格式 + 活 pid」拒绝分支（`distill-lock.ts:131-148`）。`distill-lock-multiprocess.test.ts` 有 6 子进程随机 SIGKILL 的用例，Linux 下绿。
- unlink 与 open 竞态：拿到 flock 后比对路径当前 inode 与 fd 的 inode，不一致重试（`:202-218`）。
- 持锁超时 `maxHoldMs`：只告警 + abort signal，不放锁（设计如此，CHANGELOG v4.0.0 有论证）；目前只有 `repairSingletonVersionGroups`（`store.ts:1553`）真看 signal。
- `store.delete()` 不拿写锁：已知、有意（CHANGELOG #22 *Deliberately not done*），读改写路径都已改成锁内重读 + 只更新已存在行。
- `auto-gc` 的 `gc-last` / `version-group-repair-last` 时间戳文件与 `gc-run` 锁是不同路径，`stampLock` 写的老格式 pid 不会让后来者误判成「老进程占着」。
- 跨机：flock 只在本机有效；账本写入者靠 `.writer-host` 标记 + `wx` 独占创建 + 锁内复查认领，两台机都在标记同步之前认领的窗口有文档，Syncthing 冲突落地后收敛到一个 owner。
- checkpoint `fitToCap`（#40）：输出永远 ≤ cap、不切半个代理对、恰好等于 cap 不动、超 1 个单位折成短占位符、占位符被切则连同 `key=` 一起丢、每次截断都记日志；五种改坏各自变红。
- 嵌入端把 429 文案当成「超长」再切块：已有界（只切一层，20,000 字文本对 429 端点共 5 次请求），不列为建议。

**要 owner 在 macOS 上补验的（云端与 CI 都只有 Linux）**
1. `flock.ts` 的 macOS 常量：`O_CLOEXEC = 0x01000000`、`EWOULDBLOCK = 35`、`__error` 符号、`/usr/lib/libSystem.B.dylib` 经 dyld 共享缓存 `dlopen`。CLAUDE.md 记 #27 复核后三处修复由 owner 在 macOS 上反向验证过；若 Bun 升级（当前 1.4.x），建议在 Mac 上重跑 `bun test src/__tests__/distill-lock-multiprocess.test.ts src/__tests__/distill-lock.test.ts`。
2. Bun 的 `openSync` 是否把数值 flag 里的 `O_CLOEXEC` 位原样传给 `open(2)`：可在 Mac 上用 `lsof -p <pid>` + 起一个子进程看锁 fd 是否被继承来确认。
3. macOS 上 `flock` 对 SMB / iCloud 同步目录的语义：数据目录若放进被同步的文件夹（账本根目录是），flock 只在本机生效——确认 `data/locks` 不在任何同步目录里。

## 4. 本轮刻意没列的

- 已定不做的 14 个方向、上一轮已合 / 正在做的项（Y1 / Y2 / Z、U、V、MMR 半边）。
- 可以写成「建议」但证据不够的：dream 锁 `maxHoldMs` 600 s 在长 LLM 批次下会周期性告警「looks stuck」（没有生产日志证明它真发生）；`doctor` 探测扫描器时短暂持有 `sessions-sweep` 锁，恰好撞上时 launchd 那一轮会跳过（10 分钟后自愈）。
- 两台机同时写同一场会话游标的竞态（游标在提交锁外保存，后存者赢）：只会改写诊断字段，账本本身受锁内复查保护，未复现，不列。

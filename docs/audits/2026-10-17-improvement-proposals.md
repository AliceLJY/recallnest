# RecallNest 代码体检：改进建议（2026-10-17）

> 只出建议，不改代码。基于 main `d338c97`。清单本身就是 `CLAUDE.md` §3 要求的「先出计划」；owner 筛过之后，选中的条目一件一个 session 实现。

## 0. 怎么做的、测试结果

- **全量 `bun test`**（云端，root，Bun 1.4.2，先照 CI `cp config.json.example config.json`）：**2780 pass / 0 fail / 192 files**，8164 expect，69 s。与 `CLAUDE.md` §6 的基线一致，**没有与 root 相关的红**。
- 读过：`CLAUDE.md`、`CHANGELOG.md` Unreleased 与 v3.0.x、`src/` 主路径（store / retriever / capture-engine / mcp-server 与三个 `mcp-tools-*`、distill-lock、trigger-store、kg-store、forget / cascade / gc、session-store、api-server、noise-filter、adaptive-retrieval）、相关测试。
- 所有复现都在 scratchpad 里的仓库拷贝上做，用临时 LanceDB 和假嵌入器，不连网、不碰真实数据。一次性的「改坏看红不红」也只在拷贝里改。**仓库本身只新增了这一个文件。**
- CHANGELOG 里已经写明「Deliberately not done」的残留（`delete()` 不持锁；把早先读到的 metadata 字符串交给 `update()` 的调用方；checkpoint 镜像同毫秒覆盖 / 清除之后冻结的写方；HTTP 不注册中文分词）**不重复报**，除非这次有新证据，那样会标 `known-deferred`。
- 任务说明里「已经定过」的 12 个方向一条都没有碰。没有要推翻的。

## 1. 摘要表（按 价值 ÷ 风险 排序）

| # | 标题 | 类别 | 严重度 | 改动范围 | 能否单仓做完、测试当裁判 |
|---|---|---|---|---|---|
| 1 | 检索入口的「琐碎查询」闸把显式 `search_memory` 也拦了（`git push 规则`、`jina v5`、`#22` 直接返回空） | 检索 | P1 | 1 文件，约 3 行 | 能 |
| 2 | 回收过期锁有竞态：持锁进程死后，两个进程能同时拿到 `store-write` | 正确性 | **P0** | `distill-lock.ts` + 测试 | 能 |
| 3 | `checkpoint_session` 先删旧版、再写新版，写失败被吞，工具仍报成功，旧版已经没了 | 正确性 | P1 | `session-store.ts` | 能 |
| 4 | 连带降级按 family 匹配 scope：忘掉 `memory` 里的一条，会把 `memory:pivot` 的条目降级 | 正确性 | P1 | 1 行 + 测试 | 能 |
| 5 | 噪声过滤在检索端误删真记忆（一行日志时间戳、「新会话…」开头、「我不确定」、「Hello-Agent」），写入端不过滤，于是存得进、永远搜不到 | 检索 | P1 | `noise-filter.ts` | 能（另需一次全库重放计数） |
| 6 | 重写 trigger 时先删后嵌入：嵌入失败旧 trigger 全丢，错误被吞；跨进程并发会写出重复行 | 正确性 | P1 | `trigger-store.ts` | 能 |
| 7 | 写工具回执说「已存」而实际没存：`batch_store` 把 rejected / conflict 计成 new；HTTP 对 rejected / skipped 回 `stored: true`；被判重的写入不写 trigger，回执却显示 `Triggers: 3` | 正确性 / 文档 | P1 | 3 个 handler + capture-engine 的 skip 分支 | 能 |
| 8 | 只有正文被脱敏：case / pattern / memory 的 metadata 里留着原文密钥，trigger 原文直接送去外部嵌入接口 | 正确性（隐私） | P1 | `capture-engine.ts`、`trigger-store.ts` | 能 |
| 9 | 44 个工具里只有 6 个的 handler 被测试调用过；拿掉 `store_memory` 的 trigger 接线，全量照样绿 | 测试缺口 | P1 | 只动测试 | 能 |
| 10 | category、superseded / archived、topicTag、日期这几个过滤都在候选截到 20 条**之后**才跑，排在第 21 的目标直接 0 结果 | 检索 | P1 | `store.ts` + `retriever.ts` 过滤点，中等 | 能（需 owner 确认这不算 08-22 否掉的「扩池」） |
| 11 | 同 key 写入不看 scope（`known-deferred`，新证据：同标题的 workflow pattern 跨项目互相覆盖；同文的 `events` 在另一个 scope 被判重、不写） | 正确性 | P1 | 核心写路径 | 能（影响 promote / pivot-apply，要单独互审） |
| 12 | 默认 canonical key 会塌缩：西里尔 / 韩文正文都落到 `<类别>:memory`，前 120 字相同的英文条目共用一个 key，后写的覆盖先写的 | 正确性 | P1 | `memory-boundaries.ts`，核心写路径 | 能 |
| 13 | 锁的过期时间由**等待方**决定，持锁方从不刷新：持 30 分钟锁的修复任务，30 秒后就被别的写方夺走 | 正确性 | P1 | `distill-lock.ts`、`store.ts` | 能 |
| 14 | 两处破坏分数顺序：MMR 把近似重复挪到整张表末尾；BM25 精确词补充无条件插到最前 | 检索 | P2 | `retriever.ts` 两个函数 | 部分能（MMR 阈值要看生产向量分布） |
| 15 | 「TypeScript strict」没有落地：没有 tsconfig，CI 的「TypeScript check」只跑 `bun build`；严格 tsc 报 322 条错，269 条是工具 handler 参数隐式 any | 测试缺口 / 文档 | P2 | `mcp-server.ts` / `mcp-tool-deps.ts` 类型 + tsconfig + CI | 能 |

第 3 节另列了「观察到、但没进前 15」的几条（证据较弱、潜伏在默认关的开关后面，或测试当不了裁判）。

---

## 2. 逐条

### 1. 检索入口的「琐碎查询」闸把显式 `search_memory` 也拦了 — 检索 · P1

- **证据**
  - `src/retriever.ts:869` 对**所有**调用方跑 `shouldSkipRetrieval(rawQuery)`，命中就 `return []`。这套规则是从上游同步来的「聊天消息是否值得自动检索」判定（`src/adaptive-retrieval.ts:1-3` 的注释写明是为了省嵌入调用）。
  - 三条规则误伤显式查询：
    - `adaptive-retrieval.ts:22`：以 `run|build|test|ls|cd|git|npm|pip|docker|curl|cat|grep|find|make|sudo` 开头一律跳过。
    - `:32`：`\p{Emoji}` 能匹配 0-9、`#`、`*`，所以纯数字、`#22` 这种查询被当成 emoji 跳过。
    - `:69-73`：不含 CJK、带空格、短于 15 个字符的跳过。
  - 当场复现（仓库内只读执行）：
    ```
    bun -e 'import {shouldSkipRetrieval as s} from "./src/adaptive-retrieval.ts"; …'
    "git push 规则" true   "docker 部署方式" true   "test 基线多少" true
    "#22" true   "2780" true   "lancedb lock" true   "jina v5" true   "push rules" true
    "cobbler" false   "推送规则 git push" false
    ```
  - 临时库端到端：存一条「git push 只推 origin…」（与查询 cosine 0.99），`retrieve("git push 规则")` 返回 **0 条**，换成 `推送规则 git push` 返回 1 条。`search_memory` 的跨 scope 回退也走这道闸，一样是空。
  - 被闸掉时，用户看到的和「库里确实没有」完全一样。2026-08-08 那段注释（`:58-66`）修过同类问题的一角（单 token 豁免），但留下了上面三条。
- **建议改法**：只在 `context.source === "auto-recall"` 时调用 `shouldSkipRetrieval`；显式查询（MCP `search_memory`、CLI、HTTP）只跳过空串和纯空白。
- **范围**：`retriever.ts` 约 3 行 + 测试。不碰写路径。
- **单仓能做完**：能。注意 `known-item-eval` 把闸掉的查询单独计数（`known-item-eval.ts:280`），它的 `gateSkipped` 会变，需要同步更新。

### 2. 回收过期锁有竞态：两个进程能同时持有 `store-write` — 正确性 · **P0**

- **证据**：`src/distill-lock.ts:89-112`。锁文件存在时，代码先读 pid / mtime 判断能不能回收，然后 `unlinkSync(lockPath)` 再 `tryExclusiveCreate`。A、B 都读到同一份过期锁时，可能出现这样的顺序：B 删掉旧锁 → B 建好新锁 → A 的 `unlinkSync` 删掉的是 **B 刚建的新锁** → A 也建锁成功。O_EXCL 只保证「建」是互斥的，「删」不受约束。
- **复现**（拷贝里的 `probe-lock.ts`：留一个 pid 已死的锁文件，8 个子进程同时 `acquireLock`，重复 40 轮）：**30 / 40 轮出现不止一个赢家**（我复跑一遍是 30 / 40，agent 第一遍是 28 / 40）。
- **影响**：任何持有 `store-write` 的进程被杀掉之后，下一批写方之间的互斥就不成立了。Unreleased 里几处「在锁内读改写」的修复（#22、metadata RMW、checkpoint 镜像）都以这把锁真正互斥为前提。十来个 mcp-server 进程共用一个库，进程被杀并不罕见。
- **测试缺口**：`distill-lock.test.ts` 只在单进程里跑，没有多进程同时回收的用例。
- **建议改法**：回收时先用另一个 O_EXCL 文件（`<lock>.reclaim`，短过期）互斥，在它里面重读锁文件，只有内容仍等于先前读到的那份过期内容才删；或者改成 `rename` 到唯一名字再检查。另加多进程用例：N 个子进程同时回收，断言至多一个赢家。
- **范围**：`distill-lock.ts` + 测试。是核心锁，但改动集中在一个函数。
- **单仓能做完**：能（子进程测试仓库里已有先例，见 `ingest-transcript-gate-cli.test.ts`）。

### 3. `checkpoint_session` 写失败被吞，旧版已经删了 — 正确性 · P1

- **证据**：`src/session-store.ts:79-93`。`save()` 先把同一 `checkpointId` 的旧文件全部 `unlinkSync`，再 `writeFileSync`。写入不是原子的（没有临时文件 + rename），失败时 `catch` 只打一行日志，照样 `return parsed`。`listRecent` 遇到截断的文件会静默跳过（`:115`）。HTTP `/v1/checkpoint` 走同一条路径（`api-server.ts:453`）。
- **复现**（`probe-checkpoint.ts`：带 `idempotencyKey` 存 v1，再在 v2 的目标路径上放一个目录，制造 EISDIR）：
  ```
  [recallnest] Failed to save session checkpoint: EISDIR …
  R2 tool output: Checkpoint chk-6ab9 … Updated: 2026-10-17T11:00:00.000Z   isError: undefined
  getLatest: null
  ```
  v1 被删掉了，v2 没写成，工具还报告成功。
- **建议改法**：先写 `path.tmp` 再 `rename`；rename 成功之后才删旧版本；失败时抛出，交给 `runToolSafely` 标成 `isError`。
- **范围**：`session-store.ts` 一个函数 + 测试。用「目标路径放一个目录」制造失败，root 下也稳定，不用 `chmod`。
- **单仓能做完**：能。

### 4. 连带降级（cascade forget）越过 scope 边界 — 正确性 · P1

- **证据**：`src/cascade-forget.ts:71-76` 调 `vectorSearch(..., [forgottenEntry.scope])`，用的是默认的 `"family"` 匹配；不带冒号的 scope 会变成 `scope LIKE 'memory%'`（`src/store.ts:256-260`），连 `memory:pivot`、`memory-foo` 一起匹配上。注释写的是「in the same scope」。`memory:pivot` 在其他地方都被明确保护不动（CHANGELOG 里 reconcile 那一条）。
- **复现**（`probe-cascade.ts`）：忘掉 scope `memory` 里的一条之后：
  ```
  memory:pivot  importance 0.9 -> 0.604 tier working
  memory        importance 0.9 -> 0.900 tier core
  demoted 1
  ```
  被降级的是另一个 scope 里的手写记忆，同 scope 那条反而没动。
- **测试缺口**：`cascade-forget.test.ts` 只用 `project:test` 这一个 scope。
- **建议改法**：传 `"exact"`。加一条用例：`memory` 与 `memory:pivot` 各一条相似记忆，忘掉前者，后者不变。
- **范围**：1 行 + 测试。
- **单仓能做完**：能。

### 5. 噪声过滤在检索端误删真记忆 — 检索 · P1

- **证据**：`retriever.ts:1575` 默认对候选跑 `filterNoise`（`filterNoise: true`，`:284`）；写入端（`capture-engine.ts`）不跑。所以一条被判成噪声的记忆能存进库，却永远搜不到，回执是成功。误判来自 `src/noise-filter.ts`：
  - `:77`：「裸时间戳」这条带 `/m`，`[^\]]*` 允许时间戳后面跟任何内容。于是正文里**任意一行**以 ISO 时间戳开头的日志（`2026-10-05T16:38:03Z ERROR …`），不论正文多长，整条记忆都被判成噪声。`:76` 的 YAML 块那条也带 `/m`。
  - `:57`：`^新(会话|对话|聊天)` 不限长度。
  - `:49`：`^(hi|hello|hey…)\b` 不限长度，「Hello-Agent 项目…」中招。
  - `:22`：`我不(太)?确定` 在 200 字以内一律命中（09-11 加的长度门槛只挡住了更长的文本）。
- **复现**（仓库内只读执行 `isNoise`）：以下 4 条都返回 `true`：
  - 一条带一行日志的复盘：「复盘：ingest 在凌晨失败。日志如下：\n2026-10-05T16:38:03Z ERROR commit conflict\n根因是 delete 不持锁…」
  - 「新会话启动时先调 resume_context，再看 open-loops…」
  - 「规则：遇到我不确定的 API 行为，先查官方文档再写代码。」
  - 「Hello-Agent 项目已于 9 月归档…」
  
  临时库端到端：带日志行的那条（cosine 0.97）从结果里消失，只剩一条弱干扰项。
- **建议改法**：检索端只认「整段短话」型噪声。时间戳规则去掉 `/m`、锚定全文（后面只允许空白）；boilerplate 规则也加 `UTTERANCE_MAX_LENGTH`；`我不确定` 这类收窄到短句，或干脆只在写入 / ingest 端用。
- **范围**：`noise-filter.ts` + 测试。
- **单仓能做完**：用例部分能。上线前建议照 09-11 的做法，在快照上用新旧 `isNoise` 各扫一遍全库，数清楚救回了多少条、新误判多少条（这一步要 owner 的快照）。

### 6. 重写 trigger 时先删后嵌入 — 正确性 · P1

- **证据**：`src/trigger-store.ts:224` 先 `delete`，`:226` 再调 `embed()`（网络调用），`:239` 才 `add`。嵌入失败时旧 trigger 已经删了；调用方 `capture-engine.ts:1005` 吞掉错误，只记一句「memory stored, trigger 入口未写」，看不出旧入口被清空了。判重之后的再存也会走这条路（pivot 提示里说「同 key 再存一次带 triggers 即可补上」）。另外，写入用 `add`、id 是 `${memoryId}#i`，写锁只在进程内（`withWriteLock`），两个进程同时重写同一条记忆的 trigger 会写出重复行。
- **复现**（`probe-trig.ts`，原代码）：`before: 2` → `upsert threw: embed 503` → `after failed revision: 0`；两个实例并发重写：`4` 行，应为 2。把 embed 挪到 delete 之前（只在拷贝里改）之后，两项分别是 2 和 2；`trigger-store`、`retriever-trigger-recall` 两个测试文件 14 条全绿，**说明现有测试没有钉住这个顺序**。
- **建议改法**：先嵌入，再在一次持锁里删、加；或者按 `id` merge 后删除 `memory_id = X AND id NOT IN (…)`。跨进程那一半要么换成跨进程锁，要么改成按 id upsert。
- **范围**：`trigger-store.ts` + 测试。
- **单仓能做完**：能。

### 7. 写工具的回执与实际结果不符 — 正确性 / 文档 · P1

- **证据**
  - `batch_store`（`src/mcp-tools-advanced.ts:882-886`）：不是 deduped 或 updated 的一律计成 `new`，rejected 和 conflict 也算在里面。复现（`probe-batch.ts`，4 条里 2 条过短）：`Stored 4 memories (4 new, 0 deduped, 0 updated)`，表里实际 **2 行**。
  - HTTP `/v1/store`（`src/api-server.ts:249`）：`stored: stored.disposition !== "conflict"`，所以 rejected、skipped 都回 `stored: true` 和 201；skip 时 id 是字面量 `"skipped"`。
  - `store_memory`（`src/mcp-tools-core.ts:146-154`）：无论结果如何，第一行都写 `Stored memory …`，rejected 时还会出 `Canonical key: undefined`。偏好匹配器判重时（`capture-engine.ts:1199-1215`），在 `writeTriggersForEntry` 之前就提前返回，0 条 trigger 写入，回执却照样显示 `Triggers: 3`；它也不告诉调用方重复的是哪一行。`:156` 的 pivot 提示「deduped 也会写入口」在这条分支上不成立。
- **影响**：agent 读回执来决定要不要重试或补 trigger。回执说存了，它就不会再存。
- **建议改法**：
  - 第一行按 disposition 写，rejected 时写「Not stored」；
  - 判重时返回被命中那一行的 id，并对它写 trigger；
  - `batch_store` 按 disposition 分别计数；
  - HTTP 的 `stored` 只对 stored / updated / promoted 为真，rejected 不回 201。
- **范围**：3 个 handler 加 capture-engine 的 skip 分支。HTTP 响应体改字段语义之前，按 `CLAUDE.md` §2 先确认调用方。
- **单仓能做完**：能（配合第 9 条的 handler 测试）。

### 8. 只有正文被脱敏 — 正确性（隐私）· P1

- **证据**：`persistMemory` 只对 `text` 脱敏（`capture-engine.ts:1045-1049`）。case / pattern 的结构化 metadata 用的是原始入参（`:1504`、`:1549`），脱敏只作用在行的 `text` 字段（`:1488`、`:1533`）。trigger 原文原样进 `embedQueryBatch`（生产是外部的 Jina 接口）、`metadata.triggers` 和侧表。
- **复现**（`probe-redact.ts`，用一个 `ghp_…` 形态的 token）：
  ```
  696010e1 text has key: false | metadata has key: true     (case)
  0f1d1ee1 text has key: false | metadata has key: true     (pattern)
  36127551 text has key: false | metadata has key: true     (memory)
  strings sent to embedder containing key: 1
  ```
- **测试缺口**：`pii-redact.test.ts` 只覆盖 `persistMemory` 的 text。
- **建议改法**：在拼 metadata 之前对结构化字段脱敏；在 `normalizeTriggerTexts` 里脱敏。`tags` 和显式 `canonicalKey` 顺带覆盖。
- **范围**：`capture-engine.ts`、`trigger-store.ts` + 测试。
- **单仓能做完**：能。

### 9. 写工具 handler 基本没有测试 — 测试缺口 · P1

- **证据**：`registerTool` 一共注册 44 个工具（`contracts.test.ts` 钉的是 44）。只有 6 个的 handler 在测试里被真正调用过，都是通过捕获 `registerCore/Advanced/GovernanceTools` 的方式：`search_memory`、`checkpoint_session`、`resume_context`、`forget_memory`、`manage_alias`、`memory_drill_down`。`store_memory`、`batch_store`、`store_case`、`store_workflow_pattern`、`promote_memory`、`set_reminder`、`latest_checkpoint`、`pin_memory`、`distill_session`、`dream`，以及全部 conflict / brief 治理工具，只出现在源码 grep 守卫或描述检查里。`CLAUDE.md` §2 要求「新增 MCP tool 必须同时写测试」。
- **改坏不红**（拷贝里一次性改动，改完还原）：从 `store_memory` 的 handler（`mcp-tools-core.ts:112-121`）里拿掉 `triggerStore` 和 `embedQueryBatch`，也就是 trigger 永远写不进侧表，全量测试结果与改动前相同（拷贝里是 2778 pass / 0 fail / 1 error；那个 error 是拷贝没有 `.git`，`privacy-regression` 跑 `git ls-files` 失败，改前改后都在）。第 7、8 条也正是因为这个缺口才漏过去的。
- **建议改法**：把 `tool-error-surfacing.test.ts` 里现成的捕获 harness 抽成共用 helper，每个写工具加一条临时库冒烟用例，断言回执和表里的行一致。先做 `store_memory`、`batch_store`、`store_case`、`store_workflow_pattern`、`promote_memory`、`set_reminder`。
- **范围**：只动测试。
- **单仓能做完**：能。

### 10. 过滤在候选截断之后才跑 — 检索 · P1

- **证据**：`src/store.ts:709`、`:756`：向量检索多取到 200 行，但在做任何资格检查之前就截到 `safeLimit`（≤ 20）。category 与 archived 过滤在 `retriever.ts:1238-1246`，superseded / archived / consolidated 在 `finalizeResults` 里去掉。topicTag 在 `retrieve()` 里、`finalizeResults` 已经截到 `limit` 之后才过滤；after / before 由 `search_memory` 的 `applyExplicitTemporalFilters` 处理，作用在 `limit*3`（`mcp-tools-core.ts:427`，上限 20）上。checkpoint 镜像那次已经为 `excludeScopes` 把条件下推进 SQL 修过同一类问题（CHANGELOG Unreleased「Retrieval side」一段），这里是剩下的部分。
- **复现**（临时库，`zz-audit.test.ts`）：
  - 20 条更接近查询的 `events` 加上一条排第 21 的 `preferences` 目标，`category:"preferences"` 检索 → **0 条**（把分数下限降到 0 重试也一样）。
  - 20 条 superseded 历史行加上 active 的当前行（cosine 0.93）→ **0 条**。版本链长的记忆最容易碰上：每次修订都会留下一条与当前行几乎同文的历史行。
  - topicTag `deploy`：不加过滤时目标排第 19，`limit 15` 加过滤 → **0 条**。
- **建议改法**：
  - `category` 是列，直接下推成 SQL；
  - `archived` 与 `isActiveMemory` 在 `store.vectorSearch` 的循环里、`mapped.length >= safeLimit` 的 break 之前判断，用的仍是已经取到的 200 行，不增加取数；
  - topicTag、after、before 作为池过滤传进 retriever。
- **范围**：`store.ts` 加 `retriever.ts` 的几个过滤点，中等。
- **单仓能做完**：能。需要 owner 确认这件事不属于 2026-08-22 否掉的「扩大候选池」：池仍是 20 条，只是变成 20 条**合格**的。不带过滤的查询，除了 superseded 那种情况，结果不变。

### 11. 同 key 写入不看 scope — 正确性 · P1（`known-deferred`，有新证据）

- **已知部分**：CHANGELOG Unreleased 第 165 行记过：在 B 里第一次写某个 key，而 A 里已有这个 key 时，会用 B 的正文改写 A 的行。HEAD 上照样复现（`probe-scope-blind.ts`，`entities` / key `laptop`：B 返回 `updated`，行仍在 `project:a`、正文变成 B 的；`project:b` 一行都没有）。
- **这次的新证据**：
  - `store_workflow_pattern`：两个项目里同标题（「Release checklist」）的 pattern 互相覆盖。key 由标题生成，**不需要显式 key 就会撞**。
  - 全文相同的写入，在另一个 scope 返回 `deduped` 和 A 那一行，对所有类别都是这样，包括本该只追加的 `events`。B 什么都没写，回执是 `Scope: project:a`；之后按 `project:b` 过滤的检索永远找不到这条。
- **证据位置**：`capture-engine.ts:472-489`（`findCanonicalMatches` 扫所有 scope），在 `:627-742` 被使用。
- **建议改法**：`findCanonicalMatches` 加上 `entry.scope === params.scope`，与 `deterministicId(scope, key)` 的语义对齐。
- **范围**：核心写路径，会影响 `promote_memory`、pivot-apply 和所有默认 key 的写入（CHANGELOG 原话：「gets its own review」）。
- **单仓能做完**：能（临时库用例照 probe 写）。风险高于前面几条，所以排在这里。

### 12. 默认 canonical key 会塌缩 — 正确性 · P1

- **证据**：`src/memory-boundaries.ts:148-157` 把 `[a-z0-9]` 和汉字以外的字符都换成 `-`，再截到 120 字；结果为空时退回 `<类别>:memory`（`:185-189`）。
- **复现**（`probe-scope-blind.ts` case 4 / 6）：
  - 同一 scope 先后写「Иван — мой коллега…」和「Пётр — мой брат…」，两条都得到 `entities:memory`，后者返回 `updated`，Иван 被标成 superseded。
  - 韩文落到 `profile:memory`；日文假名被剥掉，只剩 `profile:東京-近-住`。
  - 两条前 120 字相同的英文 entity 共用一个 key，后者 `updated`，前者被归档。
  
  再叠加第 11 条，任何不带 key 写入的非拉丁、非汉字 profile / entity / preference / pattern，**跨所有 scope** 争同一行。
- **建议改法**：归一化之后为空或发生了截断时，在后面附上全文的短哈希。加西里尔一对、长公共前缀一对两组用例。
- **范围**：`memory-boundaries.ts`，核心写路径。只影响以后新写的 key，已有的行保留原 key。
- **单仓能做完**：能。

### 13. 锁的过期时间由等待方决定，持锁方从不刷新 — 正确性 · P1

- **证据**：`withLock` 的过期时间取自**调用方**自己传的 `expireMs`。`repairSingletonVersionGroups` 用 30 分钟的过期持有 `store-write`（`store.ts:1586`），其他写方等锁时传的都是 30 s（`store.ts:496/563/606/636/1222/1292/1401/1508`）。所以 30 s 之后，任何写方都会把仍在运行的持锁方当成过期锁回收；30 分钟只在「自己等自己」时生效。另外默认等待预算 10 s（`distill-lock.ts:261`）短于 30 s 的过期：持锁 10–30 s 期间，等待方会直接抛错。
- **复现**（`probe-expire.ts`）：子进程以 30 分钟过期持锁，把锁文件 mtime 往回拨 31 s，父进程先打印 `PARENT_ACQUIRED while child alive`，子进程之后才打印 `CHILD_DONE`。
- **建议改法**：把持锁方的过期时间写进锁文件（`<pid>:<token>:<expireAt>`），等待方按文件里的值判断；长时间持有 `store-write` 的任务像 memory-reconcile 的 `touchLocks` 那样定时刷新 mtime。和第 2 条一起改最省事。
- **范围**：`distill-lock.ts`、`store.ts`。
- **单仓能做完**：能。

### 14. 两处破坏分数顺序 — 检索 · P2

- **MMR**：`retriever.ts:2561` `return [...selected, ...deferred]`。与已选结果 cosine > 0.85 的候选被挪到**所有**不相似候选之后，而不是只往下挪一点。复现：A（0.80）、B（0.79），cos(A,B) = 0.88，另有 6 条 0.65–0.70 的无关结果。B 的最终分 0.716 排第二，却落到 8 条里的第 7，`limit 5` 时直接看不到。
- **BM25 补充**：`retriever.ts:1071` `[...supplements, ...vectorResults]`。查询里带文件名、全大写常量、snake_case 或 commit hash 时，最多 3 条 BM25 结果无条件排到最前，并且不经过评分链、分数下限、噪声和去重。复现：查询 `how is length normalization computed in retriever.ts`，答案（向量分 0.770）排第 4，第 1–3 是三条不相关的「Edited retriever.ts today…」（cosine 0.40）。顺带一个小问题：`entity-resolver.ts:18/105` 把 BM25 查询里的 `retriever.ts` 改写成 `retriever.typescript`（`\bts\b` 能匹配点后面的 `ts`）。
- **建议改法**：MMR 改成真正的 λ·相关度 − (1−λ)·最大相似度重排，或者限制被延后的条目每遇到一个相似的已选结果只降一位；补充结果按分数并入，或至少排在向量第 1 名之后；实体别名不改写带点的文件名 token。
- **范围**：`retriever.ts` 两个函数、`entity-resolver.ts` 一个正则。
- **单仓能做完**：BM25 那半能。MMR 的阈值和 λ 要先在生产 jina-v5 向量上看同主题记忆之间的 cosine 分布；0.85 在生产上是否常被越过，这次没有测过，标 `[low-confidence]`。

### 15. 「TypeScript strict」没有落地 — 测试缺口 / 文档 · P2

- **证据**：
  - 仓库里没有 `tsconfig.json`，也没有 `typescript` 依赖；`.github/workflows/ci.yml` 的「TypeScript check」一步跑的是 `bun build src/cli.ts --outdir …`，它只转译、不做类型检查。
  - 在拷贝里加一份 strict tsconfig（`strict`、`skipLibCheck`、`@types/bun`），用 tsc 5.6.3 跑 `src/`（不含测试）：**322 条错**。其中 269 条在三个 `mcp-tools-*.ts`（TS7031 隐式 any 223 条、TS2559 44 条）。
  - 根因：`mcp-server.ts:164-165` 和 `mcp-tool-deps.ts:25-26` 用 `Parameters<McpServer["tool"]>[2]` / `[3]` 取类型，而 `server.tool` 有多个重载，`Parameters` 取到的是最后一个（第 3 个参数是 annotations）。所以 44 个 handler 的入参全是隐式 any：schema 和 handler 脱节时编译不会报。`CLAUDE.md` §1 写的是「禁止 `any`」。
  - 剩下的 53 条里有几条值得看：
    - `context-composer-task-ranking.ts:137` 比较 `boundary.layer === "working"`，但 layer 的取值里没有 `"working"`，是死分支，canonical / session 两层都拿不到加分；
    - `retriever.ts:18/44` 重复导入 `logInfo`；
    - `capture-engine.ts:1371` 等 5 处 `source` 类型收窄不一致。
- **建议改法**：
  - 把 `ToolSchema` / `ToolHandler` 换成显式的 `ZodRawShape` 加泛型 handler（或改用 SDK 的 `registerTool` 签名）；
  - 加 tsconfig 和 `typescript` dev 依赖；
  - CI 加 `bunx tsc --noEmit`，先只对已经清零的文件生效，逐步扩大；
  - 修 `"working"` 死分支前先确认原意。
- **范围**：类型声明 2 文件 + tsconfig + CI 一步；逐文件清错可以拆成多次。
- **单仓能做完**：能，tsc 本身就是裁判。

---

## 3. 观察到、但没进前 15

都有证据，但价值较低、潜伏在默认关的开关后面，或者测试当不了裁判。

- **`KGStore` 看不到别的进程的写入**（P1，潜伏，`RECALLNEST_KG_MODE` 默认关）
  - `kg-store.ts:126` 连接时没设 `readConsistencyInterval`（MemoryStore、TriggerStore 都设了，原因见 `env-config.ts:201-206`）。
  - `deleteBySource` 在锁外读、用 `whenNotMatchedInsertAll` 写回（`:465/494`）。
  - 两个实例复现：B 陈旧视图下的 `deleteBySource("m1")` 把仍有 m3 作证据的 o1 整条删了，m2 的三元组反而留着。forget 的 KG 回读（`forget-engine.ts:284`）读的是同一个陈旧视图。
  - 只加 `readConsistencyInterval: 0` 一项，probe 就得到正确结果，相关 76 条测试全绿。
  - 建议和 `CLAUDE.md` §5 要求的「开 KG 之前先清悬空三元组」放在一起做。
- **GC 归档时不在锁内复判**（P2）：`auto-gc.ts:219-223` 无条件写 `status: "archived"`。扫描之后被 pin（importance 0.96）并 superseded 的行照样被归档，`superseded` 状态也被覆盖（`probe-gc.ts`）。窗口是秒级。
- **session distill 吞错**（P2，只读过代码，没写复现）：`session-distiller.ts:249` 是 `catch { // Non-fatal }`，既不打日志也不计数；`:316` 的锁用默认 10 s 等待，锁里有嵌入和 LLM 调用，并发 distill 同一 scope 时会超时，已经算好的摘要随之丢失，与「brief wait is lossless」的注释不符。
- **中文短事实被 10 字下限拒收**（P1，但这是取舍题，要 owner 定）
  - `admission-control.ts:35` 的 `minTextLength: 10` 按 UTF-16 计数。「我对花生过敏」「我是左撇子」「女儿生日是三月五号」都被 rejected，「Alice likes tea」能过。`store_memory` 的 schema 是 `min(1)`，描述里没提这个下限。
  - 另外，生产调用方没有一个传 `rateLimiter`，所以 CHANGELOG 里引用的「每 scope 每分钟 50 条」实际不生效，属于文档与实现不符。
- **HTTP 与 MCP 分叉**（P2，只读过代码）：`api-server.ts:245` 的 `/v1/store` 不传 `triggerStore`，trigger 只进 `metadata.triggers`、进不了侧表，要等 `triggers-backfill --rebuild`；`:268` 的 `/v1/capture` 不传 `auditLogger`。
- **相关度被 importance 压过**（P1，测试当不了裁判）
  - `store.ts:730` 用 `1/(1+distance)`，把 cosine 0.6–0.9 压进 0.71–0.91；`retriever.ts:2032` 的 importance 因子是 0.5–1.0，比相关度信号本身的跨度还宽。
  - 复现：cosine 0.80、importance 0.7（`store_memory` 默认）得 0.658；cosine 0.62、importance 1.0 得 0.671，排在前面。
  - 改它会动所有阈值，必须在快照上用 48 条查询和 known-item 重放验证，不适合拿单测当裁判。
- **source diversity 挤掉同 scope 的强命中**（P2）：`retriever.ts:1598`，`sourceDiversity: 1`。跨 scope 检索 `limit 3` 时，分数 0.770 的第二名被两条 0.62 挤出去。建议只在该 scope 的最好命中不低于第 k 名 × 0.9 时才保底。
- **`hardMinScore` 对六个真实类别都不生效**（P2，文档）：`retriever.ts:856-858`。默认的 `categoryMinScores` 覆盖了全部 6 个类别，`config.json.example` 里的 `hardMinScore: 0.3` 只对未知类别起作用。
- **`list_tools` 列出没注册的工具**（P2）：`mcp-tools-core.ts:646` 按 `TOOL_TIERS` 列，不按实际注册的列；`RECALLNEST_MCP_TIER=core` 时会把调不了的 advanced 工具列成「Available」，描述为「(no description)」。
- **forget「找不到」被归类成 `internal_error`**（P2）：全量测试输出里 `forget_memory failed [internal_error/…]: Memory abcd1234 not found`。调用方会把一个输入错误当成服务端故障。

## 4. 检查过、没问题的

- 拼进过滤字符串的 id / scope 都经过 `escapeSqlLiteral`，或者校验过是 hex / UUID（`store.ts:838/867`）。唯一的缺口是 family 匹配里 scope 名中的 `_`、`%` 会被当成 LIKE 通配符（`store.ts:260`）。应用层的二次过滤在所有调用点都兜住了，只有 `bulkDelete` 例外，而它没有生产调用方。
- 没有找到嵌套获取 `store-write` 的路径（锁不可重入，没有死锁）。
- FTS 索引只在建表时建一次（`store.ts:389`），但之后写入的行仍能被全文检索查到（`numUnindexedRows: 3`，3 条都找得到）。这只是速度成本，不是召回缺口。
- 拷贝里所有 probe 脚本（`probe-*.ts`、`zz-audit.test.ts`）都在 scratchpad 里，没有提交。拷贝里留下的一次性改动只在拷贝里，仓库文件没有任何改动。

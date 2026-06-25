# RecallNest Canary Eval

- Generated: 2026-06-25T04:06:29.379Z
- Cases: 6
- Passed: 2/6
- Average score: 40.0%
- Top1 hit: 2/6
- Top3 hit: 2/6

| Case | Profile | Score | Pass | Top1 | Top3 | Order | Forbid |
|------|---------|-------|------|------|------|-------|--------|
| canary-A-mem0-borrow | fact-check | 100% | yes | yes | yes | - | - |
| canary-A-dual-dir-fix | debug | 0% | no | - | - | - | - |
| canary-B-capture-heuristic-evolution | fact-check | 0% | no | - | - | bad | - |
| canary-C-scope-isolation-noise | default | 100% | yes | yes | yes | - | - |
| canary-D-writing-style | writing | 40% | no | - | - | - | - |
| canary-D-visual-style | default | 0% | no | - | - | - | - |

## Case Notes

### canary-A-mem0-borrow
- Query: mem0 对 recallnest 有没有借鉴作用
- Score: 100% (pass)
- Target ranks: a2fe9b62=1
- Top1 / Top3: yes / yes
- Order ok: n/a
- Matched content: -
- Forbidden id matches: -
- Forbidden term matches: -
- Top ids: a2fe9b62-f9a4-707e-1aab-00e3d6f56ab8, 9f57e138-dd3e-e72b-f9e2-7638656d475e, e018516a-a412-3e27-0343-f4821f59e05c, 36bb4a17-94c6-d57f-ddc1-d90a7bb6d696
- Top snippet: mem0 → RecallNest 借鉴审计（2026-06-25，CC Opus4.8，repo-insight 借鉴审计模式）。核心结论：借鉴价值主要是「外部验证」而非「新能力」，无 P0 gap。 mem0 招牌设计（V3 ADD-only + linked_memo...
- Notes: A 单目标：mem0→recallnest 借鉴审计结论该被召回。

### canary-A-dual-dir-fix
- Query: recallnest 本地两个目录反复踩坑是怎么解决的
- Score: 0% (fail)
- Target ranks: e40ab64b=miss
- Top1 / Top3: no / no
- Order ok: n/a
- Matched content: -
- Forbidden id matches: -
- Forbidden term matches: -
- Top ids: dbcb317a-fe38-6fdc-4120-22c86f1fa7d2, 574d5496-0a08-b0b0-d251-136efb4090e6, f761889e-f5df-04ed-afc5-4cb885367aff, 23b53387-b352-f2ed-e5b3-3592bc3bf81b
- Top snippet: RecallNest 本地有两个目录导致反复踩坑：~/recallnest/（MCP server 运行目录）和 ~/Projects/recallnest/（开发目录）。2026-04-11 彻底解决：用符号链接统一，~/recallnest → ~/Projects/r...
- Notes: A 单目标：~/recallnest 与 ~/Projects/recallnest symlink 统一 case。

### canary-B-capture-heuristic-evolution
- Query: recallnest 的 capture 是纯 heuristic 吗，提取到底用不用 LLM
- Score: 0% (fail)
- Target ranks: 727da608=miss
- Top1 / Top3: no / no
- Order ok: false
- Matched content: -
- Forbidden id matches: -
- Forbidden term matches: -
- Top ids: 25798a9b-e381-09bd-8620-dd7a606919e3
- Top snippet: [用户] llm之前用过，然后可能是我设置的那个比例有问题，ingest后排除的太厉害，后面就取消了成为现在的样子。你看你现在也没记起来吧~~ [助手] 哈,这一下点得准。我确实没记起来——而且更妙的是,这件事本身就成了你前面那个问题的活样本:一段你清楚记得的重要决策("L...
- Notes: B 黄金新旧对：727da608(准确版) 须排在 a2fe9b62(被纠正的旧版) 之前，直接验 confidence/recency/decay。

### canary-C-scope-isolation-noise
- Query: 工作记忆要不要做 scope 隔离
- Score: 100% (pass)
- Target ranks: 491c8b30=1
- Top1 / Top3: yes / yes
- Order ok: n/a
- Matched content: -
- Forbidden id matches: -
- Forbidden term matches: -
- Top ids: 491c8b30-dd23-88c2-026b-8142a30edb5d, b59e86b2-fb0d-b1f0-6d09-9c41ee700c6f
- Top snippet: 【元决策·工作记忆处理】Alice 三轮讨论后明确：RecallNest 里的工作/单位记忆**不做 scope 隔离、不主动 forget 清理**。 定位：工作记忆是 Alice 写单位稿/公文/写文时的"规矩"上下文，要保持可检索；隔离或删除反而帮倒忙。搜个人/小说偶...
- Notes: C 干扰项：491c8b30 = 元决策『工作记忆不做 scope 隔离』。hardNegatives 待补一条同话题但别处语境的干扰 id。

### canary-D-writing-style
- Query: Alice 的写作风格偏好是什么
- Score: 40% (fail)
- Target ranks: -
- Top1 / Top3: no / no
- Order ok: n/a
- Matched content: 口语化, 剧评腔
- Forbidden id matches: -
- Forbidden term matches: -
- Top ids: 6dba5c3f-f44a-70ed-b75e-e09e343f0936, dd88ff18-a1e2-7dc7-c14c-bcefff0e9144, 9fb09462-3f7c-cff7-09b0-2258d0feb273, b7acc2b1-4cfa-ef98-7402-35a9d31c18cb, fcaae594-5d22-2be9-5be5-f94533499ea1
- Top snippet: 写作风格再纠（2026-06-20，agentjacking 实操文）：CC 初稿又写口语、被 Alice「太口语化了！书面化一些」拉回。教训：① 技术实操/踩坑类题材尤其诱使 CC 写口语（碎句 + 口头碎词如"挺丢人的/吭哧吭哧/敞着强/较劲"），但 Alice 的书面...
- Notes: D 稳定偏好：不钉 id，召回文本命中要点即算对。

### canary-D-visual-style
- Query: Alice 的配图审美偏好
- Score: 0% (fail)
- Target ranks: -
- Top1 / Top3: no / no
- Order ok: n/a
- Matched content: -
- Forbidden id matches: -
- Forbidden term matches: -
- Top ids: 9fb09462-3f7c-cff7-09b0-2258d0feb273, 26f3bb2a-4d3b-e191-f8ea-0508d5dbcdb2
- Top snippet: [助手] 这个任务和 Alice 之前的小说审稿偏好相关，我先做一次很轻的记忆检索，避免审稿方向跑偏。
- Notes: D 稳定偏好：同上。


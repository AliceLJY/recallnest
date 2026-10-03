# RecallNest launch page — spec

A one-page, scroll-driven launch page for RecallNest, published with GitHub Pages at
`https://aliceljy.github.io/recallnest/`. Everything here is static: `index.html`, `style.css`,
`main.js`, plus `og.jpg` for link previews (a screenshot of the page's own first screen, rendered locally). No build step, no external requests, no web fonts.

## One line

Scrolling the page plays a short launch film: scattered conversation fragments gather into one
woven nest, a question pulls the right memories back out, and every client ends up connected to
the same nest. The first screen states plainly what RecallNest is.

## Concept

RecallNest launched the way a bird builds a nest: every conversation leaves a twig, and the twigs
are woven into one place that every window can come home to. The name already carries the idea,
so the visuals use it literally and the copy does not explain the metaphor.

## Visual route

Real-time particles only (WebGL 1, one point cloud that morphs between eight shapes). No generated
images or video, so no asset list or generation budget is needed. The point cloud is drawn on a
fixed full-screen canvas; all text is real HTML on top of it.

| Beat | Section id | Shape | Camera tilt / distance |
|---|---|---|---|
| 0 | `hero` | Woven nest (torus-knot strands on a rim, spiral strands for the base) | 0.48 / 6.3 |
| 1 | `scattered` | Seven separate swirls, one per verified client, labelled | 0.12 / 7.6 |
| 2 | `store` | Seven streams curving into one dense disc | 0.30 / 6.9 |
| 3 | `woven` | Six stacked coils, one per memory category | 0.52 / 6.0 |
| 4 | `recall` | Coils dimmed; a query beam drops in; five knots rise out as the ranked hits | 0.30 / 6.6 |
| 5 | `decay` | Coils fade along a Weibull curve; exempt particles stay lit | 0.55 / 6.0 |
| 6 | `home` | Small nest in the middle, seven clients on a ring, streams between them | 1.05 / 7.4 |
| 7 | `install` | The nest again, dimmed behind the install commands | 0.48 / 7.2 |

Scroll position alone decides the state: each beat is fully formed when its section's centre meets
the viewport centre, and holds for the first and last quarter of the travel between two beats. The
same scroll position always draws the same frame once idle motion is off (`?still`, or the
system's reduce-motion setting).

## Palette

| Role | Value | Use |
|---|---|---|
| Background | `#0b0907` (sRGB) | Page and canvas clear colour |
| Ink | `#f1e8da` | Headings and body text, base particle colour |
| Muted | `#a89a86` | Secondary text, labels |
| Amber (accent) | `#ffad5a` | Primary button, recall hits, pinned memories, category tint |
| Cool (recall only) | `#8fd3e8` | The query beam and the query line in the recall sample |

## Type

System fonts only, so nothing is downloaded and nothing from the overused web-font list in
`cc-skills/hyperframes/references/typography.md` is chosen: display `ui-serif` / Songti for
headings, system sans for body, `ui-monospace` for labels and code.

## Layout

- Landscape (width ≥ 760 px and wider than tall): copy column on the left (max 30 rem), scene shifted
  right by 0.30 in clip space, a left-side shade behind the copy.
- Portrait: scene shifted up by 0.30, copy pinned to the lower half with a bottom shade, recall hits
  laid out as a row instead of a column.
- Copy blocks are `position: sticky` inside 140 vh sections, so text stays put while a shape holds.

## Budget

- Particles: 24,000 in landscape, 11,000 in portrait, fixed at load.
- Device pixel ratio capped at 2.
- Page weight: HTML + CSS + JS under 60 KB uncompressed; zero third-party requests.
- Frame time while scrolling through all beats on the author's Mac mini (Chrome, 1440 × 900, DPR 2):
  median ≤ 16.7 ms, 95th percentile ≤ 25 ms.

## Facts on the page and where each comes from

| Claim | Source |
|---|---|
| Claude Code, Codex, Kimi, Antigravity, Doubao desktop, scripts / cron, phone | `README.md` "Who Can Connect" table |
| 44 MCP tools | `src/__tests__/contracts.test.ts` asserts `toHaveLength(44)` |
| 21 HTTP endpoints | 21 distinct routes in `src/api-server.ts`; README architecture block |
| LanceDB, Jina embeddings v5, 1024-dim | `CLAUDE.md` tech stack; README architecture block |
| Six categories | README "6 Categories"; `docs/memory-categories.md` |
| Three granularities picked by relevance and token budget | README "L0 / L1 / L2 Dynamic Folding" |
| Vector by default, BM25 / multi-vector / KG on demand | README note under the architecture block, Recall table |
| 2–6 trigger phrasings, used only for recall | README "Write-time Triggers" |
| Revisions supersede, history kept | README "Memory Evolution"; category merge strategies |
| Weibull decay; patterns, pinned, used within 7 days, core with importance ≥ 0.95 exempt | `src/decay-engine.ts` `isDecayExempt` |
| Evidence vs durable, promotion is a gated step | README "What a recall actually looks like" |
| `checkpoint_session` / `resume_context`, recalled state is not live state | README "Session Continuity"; `resume_context` output header |
| Recall sample block | Copied verbatim from `README.md` |
| 2,600 tests passing | CI run 36082874019 on `d1f4915`: "Ran 2600 tests across 184 files" |
| Plugin install lines, `npx recallnest --help`, Bun or Node.js 22+, Jina API key | README "Quick Start" options A and B |
| v3.0.1, MIT | `package.json`; `LICENSE` |

## Hooks for checks

- `window.__recallnest`: `ready`, `layout`, `count`, `progress()` (beat position as a float),
  `frames` (recent frame times in ms), `view(name)` (jump to a beat).
- URL parameters: `?view=<section id>` opens at that beat, `?still` turns idle motion off,
  `?lang=zh|en` forces the language, `?nogl` forces the no-WebGL fallback.

## Acceptance

1. **First screen**: a fresh agent that has not seen this spec gets only the first-screen screenshots
   (desktop and phone) and is asked what this is and who it is for. Pass if it says, in substance,
   "a shared / persistent memory layer for AI coding agents or MCP clients".
2. **Per-beat screenshots** at 1440 × 900 and 390 × 844, both languages: no text box overflows the
   viewport and no two text boxes overlap (checked from DOM rectangles), read by eye for legibility.
3. **Round trip**: with `?still`, the screenshot at each beat taken on the way down equals the one
   taken on the way back up (pixel difference under 0.5 %).
4. **Weight**: total bytes of the first load under 60 KB (excluding `og.jpg`, which the page never
   requests); zero requests to other origins.
5. **Frame time**: within the budget above while a script scrolls from top to bottom.
6. **No console errors**; `?nogl` still shows all text on a static background.
7. **Reduced motion**: with `prefers-reduced-motion: reduce`, two screenshots 1 s apart are identical.
8. **Language**: the toggle switches every visible string; `?lang=` and the browser language pick the
   default.
9. **Default visit**: no URL parameters, DPR 2, read the screenshot as a visitor would.
10. **Every number on the page** appears in the table above with a source.

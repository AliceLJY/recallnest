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

Real-time particles only (WebGL 1, one point cloud that morphs between ten shapes). No generated
images or video, so no asset list or generation budget is needed. The point cloud is drawn on a
fixed full-screen canvas; all text is real HTML on top of it.

| Beat | Section id | Shape | Camera tilt / turn / distance (`CAM` in `main.js`) |
|---|---|---|---|
| 0 | `hero` | Woven nest (torus-knot strands on a rim, spiral strands for the base) | 0.36 / 0.00 / 6.0 |
| 1 | `scattered` | Seven separate swirls, one per verified client, labelled | 0.12 / 0.00 / 7.6 |
| 2 | `store` | Seven streams curving into one dense disc | 0.30 / 0.25 / 6.9 |
| 3 | `woven` | Six stacked coils, one per memory category | 0.52 / 0.55 / 6.0 |
| 4 | `recall` | Coils dimmed; a query beam drops in; five knots rise out as the ranked hits | 0.30 / 0.15 / 6.6 |
| 5 | `decay` | Coils fade along a Weibull curve; exempt particles stay lit | 0.55 / 0.60 / 6.0 |
| 6 | `home` | Small nest in the middle, seven clients on a ring, streams between them | 1.05 / 0.00 / 7.4 |
| 7 | `releases` | Double helix with one amber knot per tagged release, in tag order; labelled on desktop (all 13) and in the video (3 milestones) | 0.10 / 0.00 / 7.2 |
| 8 | `failures` | A 3 × 3 grid of rings, one per failure in the list, cool-tinted with bright centres | 0.18 / 0.00 / 6.4 |
| 9 | `install` | The nest again, dimmed behind the install commands | 0.36 / 0.35 / 7.0 |

Portrait multiplies every distance by 1.85 (the video uses 1.5).

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
| Cool | `#8fd3e8` | The query beam and the query line in the recall sample; the failure rings and the cause / fix labels in the failure log |

## Type

System fonts only, so nothing is downloaded and nothing from the overused web-font list in
`cc-skills/hyperframes/references/typography.md` is chosen: display `ui-serif` / Songti for
headings, system sans for body, `ui-monospace` for labels and code.

## Layout

- Landscape (width ≥ 760 px and wider than tall): copy column on the left (max 31 rem; 36 rem for the
  two reading sections), scene shifted right by 0.34 in clip space, a left-side shade behind the copy.
- Portrait: the scene sits in the space between the header and the current beat's text (lifted by
  0.2–0.42 in clip space, measured from where that section's copy starts); a shade starts just above
  the text; recall hits are laid out as a row; client labels on the ring are pushed outward so they
  do not collide. The last section scrolls normally instead of sticking, because on a 375 × 667
  phone it is taller than the screen.
- Reading sections (`releases`, `failures`; class `reading`) are taller than a screen on every layout,
  so their copy scrolls instead of sticking. On phones the shade covers the whole screen and the scene
  dims to half while they are in view, and the helix labels are not drawn (the list names the versions).
  The header is opaque enough that a scrolling list passes under it cleanly.
- Copy blocks are `position: sticky` inside 140 vh sections, so text stays put while a shape holds.

## Budget

- Particles: 24,000 in landscape, 11,000 in portrait, fixed at load.
- Device pixel ratio capped at 2.
- Page weight: HTML + CSS + JS under 80 KB uncompressed; zero third-party requests. (Was 60 KB; raised on
  2026-10-03 when the two bilingual lists added about 27 KB of text: 71.7 KB measured locally.)
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
| 13 tagged releases, 514 commits | `git tag` lists 13, v1.1.0 … v3.0.1 (the same 13 names on origin); `git rev-list --count 4fe5b18` = 514 on `main`, counted at the commit before the release history was added; first commit `c10607a`, 2026-03-03 |
| Release dates | The commit that set that version in `package.json` (`git log -G'"version":' -- package.json`). v2.1–v2.2 never had a `package.json` version of their own, so the row takes the date of their feature commits (all 2026-04-11, e.g. `74609d4`, `63f1a74`). `main` is the day both ranking switches became default (CHANGELOG.md:21). The CHANGELOG's own "2026-01" / "2026-02" for v1.0 / v1.1 predate the first commit and are not used |
| Release rows | CHANGELOG.md: v1.0 :552–556 · v1.1 :542–550 · v1.2 :518–528 · v2.1–v2.2 :482–488, :496–504 · v2.3 :474–478 · v2.5.0–v2.5.2 :407–416, :433 · v2.5.3 :379, :387 · v2.5.4 :368–372 · v2.6.0 :333, :340, :348–349 · v3.0.0 :140–141, :158, :162–172, :197–200 · v3.0.1 :98, :118–130 · main :21, :23, :70 |
| Nine failures | CHANGELOG.md: dead features :383–386 · empty vectors :387, :393 · synthesis :197–209, :216–220 · request storm :179–181, :259–269 · `candidatePoolSize` :280–284 · 90-minute stall :98–110 · subagent briefs :92 (fix `e7d2fad`, 2026-09-08) · append-only ingest :68–72 · popularity :21–23, :41. "Every figure was measured on the maintainer's own production store": each entry says so (e.g. :69 "one production store", :387 "真实库") |
| Nine rings in the failures beat | One per item in the list: `main.js` counts `#failures .log li` |
| FAILURES.md fields | The entry template, FAILURES.md:18–35 |

## Hooks for checks

- `window.__recallnest`: `ready`, `layout`, `count`, `progress()` (beat position as a float),
  `frames` (recent frame times in ms), `view(name)` (jump to a beat).
- URL parameters: `?view=<section id>` opens at that beat, `?still` turns idle motion off,
  `?lang=zh|en` forces the language, `?nogl` forces the no-WebGL fallback.

## Acceptance

1. **First screen**: a fresh agent that has not seen this spec gets only the first-screen screenshots
   (desktop and phone) and is asked what this is and who it is for. Pass if it says, in substance,
   "a shared / persistent memory layer for AI coding agents or MCP clients".
2. **Per-beat screenshots** at 1440 × 900, 390 × 844 and 375 × 667, both languages: no text box
   overflows the viewport, no two text boxes overlap, no client label sits on text or on another
   label, no label sits under the header, sticky text never hides under the header, and the first
   screen's buttons are fully visible
   (all checked from DOM rectangles); read by eye for legibility.
3. **Round trip**: with `?still`, the screenshot at each beat taken on the way down equals the one
   taken on the way back up (pixel difference under 0.5 %).
4. **Weight**: total bytes of the first load under 80 KB (excluding `og.jpg`, which the page never
   requests); zero requests to other origins.
5. **Frame time**: within the budget above while a script scrolls from top to bottom.
6. **No console errors**; `?nogl` still shows all text on a static background.
7. **Reduced motion**: with `prefers-reduced-motion: reduce`, two screenshots 1 s apart are identical.
8. **Language**: the toggle switches every visible string; `?lang=` and the browser language pick the
   default.
9. **Default visit**: no URL parameters, DPR 2, read the screenshot as a visitor would.
10. **Every number on the page** appears in the table above with a source.

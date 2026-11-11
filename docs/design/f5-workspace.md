# F5 workspace design (gate D)

This is the binding design record of phase F5 (Unified workspace): the UX specification that the implementation
cards build to and that the gate U reviewers check screenshots against. It is gate D of `docs/f5-decisions.md`.

Signed by the orchestrator on 2026-11-11 after reading the final screenshots (gate D)

**Precedence.**
- `RULES.md` and `rules/` always win.
- `docs/f5-decisions.md` wins over this record for behaviour, data and keys. Where they differed, §20 records the
  binding choice. The body below already applies it, so a builder reads the body as written.
- The amendments of §20.2 are proposed to the orchestrator, who applies them to `docs/f5-decisions.md`. If one is
  rejected, the decision's text binds, and §20.1 names what to build instead.
- This record wins over the mockup. Where the mockup shows something else (for example the Cmd-K foot, the tree's
  word cuts and the rows in Ajustes), the record binds.
- Visuals, layout, copy and states follow this record.

## How the design was chosen

A design workflow built four seeded candidates (A Reading desk, B Instrument, C Atlas, D Today) as static mockups.
Three judges scored each one from 0 to 10 on one criterion each. A synthesis merged them, two critics (a first-time
user and a design director) reviewed the result, and a polish pass answered the critics. The critics raised 65 items;
each was resolved, partly resolved or rejected with a reason, and the result is the body below.

| Candidate | Intuitive | Beauty | Access and feasibility | Total |
| --- | --- | --- | --- | --- |
| **D Today (base)** | **8.5** (1st) | 8 (2nd) | **8** (1st) | **24.5** |
| A Reading desk | 7 (3rd) | **8.5** (1st) | 6 (3rd) | 21.5 |
| C Atlas | 7.5 (2nd) | 6.5 (3rd) | 4.5 (4th) | 18.5 |
| B Instrument | 5.5 (4th) | 6 (4th) | 7 (2nd) | 18.5 |

**Direction: D's structure in A's visual language, with grafts from C and B.**
- **From D, the base:** a next action on every screen, a Home briefing, a global Adicionar, an Activity pill
  written as a sentence, Inbox impact numbers, and the cheapest build on today's ShapeChart, ShapeTable and
  IcicleDiff.
- **From A:** sheet-on-desk figure and ground; serif for reading and Inter for operating; the compact previous panel;
  the evidence margin; citation passages that expand in the sources list.
- **From C:** the "Vai para" Evidence card, the Map as a reversible zoom-out, and the teaching empty states.
- **From B:** needs-you in words, suggestions judged inline, the section ruler, and F6 region cycling.

§1 lists every graft and every rejected option with its reason.

## Mockup and screenshots

**Mockup.** `docs/design/f5-workspace/mockup.html`: one self-contained file with no network. Its fonts are embedded
from the app's bundled `@fontsource-variable` files. Open it in a browser and change the hash to switch screens:
- **Destinations:** `#home #explore #library #peek #inbox #inbox-relation #map #map-graph #settings`.
- **Explore states:**
  - `#note` (focus mode), `#note-rel` (relations and the Evidence card);
  - `#source`, `#ask`, `#passage`, `#topic`, `#entity`;
  - `#cmdk`, `#activity`, `#add-menu`, `#keys`;
  - `#explore-focus` (keyboard focus rings) and `#explore-ctx` (the compact context overlay; view it at 1000 wide).
- **First run:** `#empty #first-import #empty-explore #drop`.
- **Reference board:** `#states` (loading, empty and error; a long page).

Rail clicks, ⌘K, Esc, `?` and Space (in the Library) navigate between screens. With no `data-theme` on `<html>`, the
page follows the OS theme. The mockup's data is one synthetic fixture (§17).

**Screenshots** are not committed. The tool is the orchestrator's untracked `.cache/f5/tools/shot.cjs`. It runs a bare
offscreen Electron with a temporary userData, loads only `file://`, blocks the network and starts no Memora process.
From the main checkout:

```sh
node_modules/.bin/electron .cache/f5/tools/shot.cjs --html docs/design/f5-workspace/mockup.html \
  --out .cache/f5/design/record-shots/explore-light.png --width 1280 --height 800 --theme light --hash '#explore' --wait 700
```

- **Sizes.** The reference set is 1280×800 for every screen in both themes; 1000×700 for explore, home, inbox,
  library, ask, source, inbox-relation and explore-ctx; and 1440×900 and 1680×1000 for explore. Gate U's own captures
  are 960 and 1440 (D1, §16).
- **Relations shot:** add `--eval "document.getElementById('rels').scrollIntoView({block:'start'})"` on `#note-rel`.
- **States board:** add `--full` on `#states`.
- Keep outputs under `.cache/` (gitignored).

The design workflow's own shots, candidates, judge notes and polish sources stay untracked under `.cache/f5/design/`
for reference: `final/shots/`, `A-reading-desk/` to `D-today/`, and `final/_work/`.

## Element placements (the owner's list)

| Element | Where | Section |
| --- | --- | --- |
| Path ribbon on every object | above the title of every object panel, every kind and width | §9 |
| Hover previews and citation chips | object links, tree rows and relation rows; chips expand their passage in the sources list | §10 |
| Quick-look on Space | lists, the tree, the Library and the Inbox; ⌘Y everywhere, including Cmd-K | §10.2 |
| Live generation strip | the Source page while it processes | §6.2 |
| Skeletons | every loading state after 150 ms | §5.12 |
| Teaching empty states | navigator, context panel, Explore, first-run Home, Library, Inbox | §5.12, §7.7 |
| Stance glyphs | glyph plus word in the stance colour: Conexões, relation rows, Grafo edges, legends | §4.1, §5.6 |
| Density toggle | the Library header | §7.3 |
| Focus mode | "Foco" on every top panel, and ⌘⇧F | §5.4, §8 |
| Ask with inline citations and a sources rail | the Question page; the Evidência tab is the sources rail | §6.4, §10.3 |

## Screens and the cards that build them

| Surface | Sections | Mockup | Card |
| --- | --- | --- | --- |
| Tokens and primitives | §4, §5.11, §5.12 | `#states` | T124 |
| Shell: rail, top bar (with the Activity pill), navigator host | §3, §5.1-§5.3, §5.8 | every screen, `#activity` | T135 |
| Panel stack, panel frame, path ribbon | §5.4, §5.5, §8, §9 | `#explore`, `#topic` | T136 |
| Explore, Note and Topic panels | §6.1, §6.3, §7.2 | `#explore`, `#note`, `#note-rel`, `#topic` | T141 |
| Source panel | §6.2 | `#source`, `#first-import`, `#passage` | T140 |
| Entity panel | §6.5 | `#entity` | T147 |
| Context panel | §5.6 | `#explore`, `#explore-ctx` | T143, T173 |
| Hover previews and quick-look | §10 | `#note-rel`, `#peek` | T144 |
| Cmd-K | §11 | `#cmdk` | T145 |
| Ask panel (mid-stream) and Question page | §6.4, §10.3 | `#ask`, `#passage` | T146 |
| Home | §7.1 | `#home` | T148 |
| Library | §7.3 | `#library`, `#peek` | T149 |
| Add flow, first run, drop | §5.2, §7.7 | `#add-menu`, `#empty`, `#first-import`, `#empty-explore`, `#drop` | T150 |
| Inbox and Map › Árvore | §7.4, §7.5 | `#inbox`, `#inbox-relation`, `#map` | T142 |
| Map › Grafo | §7.5 | `#map-graph` | T151, T152 |
| Ajustes | §7.6 | `#settings` | T159-T166 |

## 1. Base and what was grafted

**Base: D-today.** It is the most intuitive candidate: 8.5 for intuitive and 8 for access. Its total, 24.5, is the
highest. D's flow gives a first-time user a next action on every screen:
- the Home briefing with linked counts and one Retomar;
- a global Adicionar;
- an Activity pill written as a sentence, with a reason on each waiting row;
- Inbox impact numbers with the undo window;
- the Map "Próximo passo";
- a ribbon that wraps.

It is also the cheapest to build: lists, a thread, and the existing ShapeChart, ShapeTable and IcicleDiff. An
intuitive design beats one that is only handsome. So the structure is D's, and the visual language is A's, which won
on beauty (8.5).

| Grafted | From | Where it lives now |
| --- | --- | --- |
| Sheet-on-desk figure/ground (chrome on canvas, objects on raised sheets; dark sheets lighter than the desk) | A | whole shell, §3 |
| Serif for everything read, Inter for everything operated; display 24 on wide sheets, title 20 in panels, lead 17 in compact panels | A | §4.3 |
| Previous panel kept as a compact list with the current row highlighted; spines read top-to-bottom with the kind first | A | §8 |
| Navigator ancestors in semibold as a built-in "you are here" | A | §5.3 |
| Tufte margin on wide note sheets (evidence quotes in reading order) and citation passages expanded in the sources list, never in a card over the answer | A | §6.3, §10.3 |
| Inbox lens with words on the shapes (`novo` outlined, `sai` hatched) and "Nada muda até você aplicar" | A | §7.4 |
| Tentative place "Lugar provável:" with a dashed underline | A + C | §9 |
| Space quick-look as a centred sheet with ↑/↓ to peek the next row | A | §10.2 |
| "Vai para <path>" inside the relation hover card (the plan's Evidence card) | C | §10.1 |
| Map as a reversible zoom-out: "Esc volta para <tópico>, onde você estava" and an `aqui` marker in chart and table | C | §7.5 |
| Teaching empty states: "Os tópicos nascem sozinhos…", a context panel that previews itself, file / link / note entry, an example library | C | §7.7 |
| Cmd-K states its ranking bias ("perto de Fermentação lática primeiro") and previews the result's place | C | §11 |
| Library filter by territory (counts per root topic) | C | §7.3 |
| Needs-you count in words in the pill ("3 precisam de você") | B | §5.2 |
| Inline teaching hint at the point of action | B | Source page |
| "Lidas, não citadas" in the sources list | B + C | Question page |
| Suggested relations judged inline (Manter / Remover) with a dashed outline | B | Note page, Conexões |
| "pelas citações" as a Question's place state | B | §9 |
| Section ruler on the generation strip; cost shown on the source | B | Source page |
| Relations with columns for who decided and who wrote the explanation | B | Note page |
| Match marked by underline + weight in Cmd-K, result count and latency readout | B | §11 |
| F6 region cycling that reaches the status slot; a global reduced-motion rule | B | §12, §4.7 |
| Dashed outline = empty, skeleton = loading | B | §5.12 |

**Rejected, with the reason.**
- C's permanent two-row strip: it would be a fourth location cue, its cells read as unlabelled wallpaper, and it does
  not scale to 3,000 topics. Home has a one-line Shape strip instead (§7.1), which the plan asks for.
- C's mini-strips and its docked second stack: two stack models are one too many.
- A's "mesa" wording in controls: users would have to learn a metaphor before they can predict ↵ versus ⌥↵.
- A's layout that changes by object kind.
- A's 32 px hero: it is outside the fixed scale.
- A's paragraph-anchored margin and the source-text annotation layer: too costly for F5, deferred behind a spike.
  Source notes instead show their section and a "Ver o trecho" link.
- B's icon-only rail, its keycaps on every control, the compact default, relations shown as glyph counts, the 24 px
  status bar, the KPI tiles, and Inbox items applied before review.
- D's two kinds of back: there is no back in the top bar.
- D's yellow warning-soft used as a highlight, its filled state pills and badge tiles, its icon-only context tabs,
  its floating toast over the action bar, and its bottom-to-top spines.

## 2. Principles (each one is testable)

1. **Zero clicks to "where is this".** Every object page shows its tree path above the title. The navigator marks the
   open object, sets its ancestors in semibold, and never truncates them (they wrap to 2 lines).
   *Test:* screenshot any object page at 1280 and at 1000 and read the path and the tree row without interacting.
2. **Every state says what it is in words.** Colour and icons are never alone. Every waiting item has "motivo: …",
   every number has a noun, every risk glyph has Alto / Médio / Baixo or Bloqueada, and no chart cell shows a bare
   number.
   *Test:* convert the screenshot to grayscale and every state is still readable.
3. **One next action per screen.** At most one filled (primary) button is visible, and it is the most likely next
   step. A verdict with no safe default (the Inbox relation item) has no filled button.
   *Test:* count the filled buttons in the screenshot; the answer is ≤ 1.
4. **Nothing changes without a trace and an undo.** Every change made by the system or by the user appears on a
   thread with Desfazer. Risky structure changes wait in the Caixa de entrada, unapplied.
   *Test:* run any action and find its row and its Desfazer.
5. **Reading is the figure, chrome is the ground.** Objects sit on raised sheets and are set in serif. The reading
   column gets 60-70 characters per line at the reference size before any chrome gets width (§3). Chrome sits on the
   canvas and is set in Inter. Colour appears only for object kind, relation stance (always with a glyph) and state
   (§4.1).
   *Test:* every coloured element in a screenshot belongs to one of those three roles (the Map › Grafo topic colours
   are the plan's one exception, §4.1); a paragraph in `#explore` at 1280 has 60-70 characters per line.
6. **Clicks stack, they never teleport.** A click inside a panel or a root surface opens beside it, in the same
   destination. Only the rail, Retomar, Adicionar and the first-run file choice change the destination (§8 rule 8).
   The layout never changes because of the object's kind, and focus mode starts only by an explicit command.
   *Test:* click every link type in a panel; the destination does not change.
7. **Keyboard first, never keyboard only.** Every shortcut has a visible control. Single-key shortcuts and Space
   never fire in text fields or dialogs, and Tab always moves focus. Every hover surface also opens on focus and
   closes with Esc.
   *Test:* Tab through the screen; type "pH do chucrute" in Cmd-K.
8. **Calm and fast.** Loading longer than 150 ms shows skeletons, never a spinner; the only ring means "running".
   Motion is ≤ 240 ms and is zero under reduced motion. Cmd-K p95 is ≤ 100 ms.
   *Test:* trace and measure.
9. **No state by tint alone.** Selected, current and pressed items always carry a 2 px accent bar or inset, or a
   `--border-strong` ring, besides any tint (WCAG 1.4.11).
   *Test:* desaturate and blur the screenshot; the selected row is still findable.

## 3. Shell layout grid

All spacing (padding, margins, gaps) is a multiple of 4 px. Hairlines (1-2 px), glyph geometry and icicle gutters
(2 px) are exempt. The window minimum stays 960×640. The rem tokens equal px at a 16 px root.

**The collapse rule is tied to the reading measure, not to a fixed width.** The top panel must keep at least
`--top-min` = 568 px: a 520 px text column (about 65 characters of serif 16) plus 24 px padding on each side. When it
would get less, chrome folds in this order:
1. The previous panel becomes a spine. In CSS this is a container query on the stack: the previous panel shows only
   when the stack is ≥ 848 wide (240 previous + 40 spine + 568 top).
2. Spines beyond 6 merge into one "+N" spine at the far left.
3. At ≤ 1279 wide, the context panel becomes the 40 px strip (it opens as an overlay, §5.6).
4. At ≤ 1179 wide, the compact tier applies (table below).
5. The navigator never auto-collapses (⌘\ toggles it).

**At the window minimum** (960-999 wide), the rule bends in three places:
- The top panel may drop to 552 px with two spines. That leaves a reading column of about 496 px, 58-62 characters.
- Below that, older spines merge into the "+N" spine.
- The omni trigger keeps at least 240 px. The status slot truncates inside the pill and never covers the trigger. The
  mockup's 960 render shows the pill over the trigger's end; that is a defect.

The measured result in the mockup (note prose, serif 16 / 1.75):

| Window | Reading column | Characters per line |
| --- | --- | --- |
| 1000×700 | 535 px | 62-71 |
| 1280×800 | 511 px | 60-67 |
| 1440×900 and wider | 544 px (the `--measure` cap) | 63-68 |

**Tiers.** All widths are in px.

| Region | Wide ≥ 1440 | Standard 1280-1439 (reference 1280×800) | Narrow 1180-1279 | Compact 960-1179 (reference 1000×700) |
| --- | --- | --- | --- | --- |
| Rail `--rail-w` | 72 | 72 | 72 | 64 (items 56 wide) |
| Top bar `--top-h` | 48 | 48 | 48 | 48; the pill drops its "3 em espera" clause |
| Navigator `--nav-w` | 272 | 256 | 256 | 224; indent `--ind` 8; counts only on hover, focus or the open row |
| Context `--ctx-w` | 320, docked | 304, docked | 40 strip + 304 overlay | 40 strip + 304 overlay |
| Previous panel `--prev-w` | 240 when the stack is ≥ 848 (from about 1660) | spine | spine | spine (216 when shown) |
| Spine `--spine-w` | 40 | 40 | 40 | 40 |
| Top panel | the rest, ≥ 568 | the rest (568 at 1280 with 2 spines) | the rest | the rest (592 at 1000 with 2 spines); padding 16 |
| Focus mode | rail + spines + sheet; content grid 600 text + 48 gap + 264 margin, centred | same | same | 560 + 32 + 224 |

**Destination layouts** (they share the rail and the top bar):
- **Home:** one scroll column, max width 1136, padding 32/48. Its four sections are:
  1. The brief band, a 7fr / 5fr grid with a 48 gap.
  2. The Shape strip.
  3. Three columns with a 40 gap, laid out with the grid areas `need gard arr` / `need gard back`.
  4. At compact width, two columns with the areas `need arr` / `gard back`.
- **Library:** a header with the title, counts and the density toggle; a filter bar; the territory bar; the table;
  and a 40 px foot with keys.
- **Inbox:** a list column (360, or 300 at compact width) and the detail column. The detail is a scroll area plus a
  sticky action bar. A 40 px key bar spans the full width.
- **Map:** a 56 px header, then the 40 px zoom-out band, then the chart (1fr) and a 400 inspector-plus-table column
  (320 at compact width).
- **Settings:** a 288 section column (248 at compact width) and the content at max width 720.

**Layers (z-order):**
1. Workspace.
2. Top panel shadow.
3. Context overlay (compact) and Activity drawer (non-modal, 400, right, below the top bar).
4. Modal scrim, which covers rail and top bar (Cmd-K and the keyboard sheet only).
5. Cmd-K / Peek (non-modal, no scrim) / Adicionar menu / keyboard sheet.

**Overlay placement:**
- Cmd-K sits 72 from the top and is `min(800, 100% − 64)` wide.
- Peek sits 96 from the top and is `min(640, 100% − 64)` wide.
- The keyboard sheet sits 64 from the top and is `min(960, 100% − 64)` wide.
- The Adicionar menu is 360 wide, anchored to the chevron's right edge.

**Scrollbars:** overlay style everywhere (macOS default: thin, visible while scrolling or on hover of the scrolling
region). `scrollbar-gutter: stable` only on the navigator, the Library table and the Inbox list: there a scrollbar
appearing would move rows under the pointer and change the width that tree labels were fitted to.

## 4. Tokens

### 4.1 Colour roles

All values come from `apps/desktop/src/renderer/tokens.css` unless marked NEW. Ratios are WCAG 2.x and were computed
for this brief.

| Role | Variable | Light | Dark | Contrast (light / dark) |
| --- | --- | --- | --- | --- |
| Desk (chrome, navigator, context, spines) | `--surface-canvas` | #f5f7f9 | #10151d | n/a |
| Sheet (panels, drawer, inbox detail, settings content, cards) | `--surface-raised` | #ffffff | #171e28 | n/a |
| Inset fields, keycaps, tab set, icicle cells | `--surface-soft` | #eef2f6 | #202b39 | n/a |
| Hover | `--surface-hover` | #e8edf3 | #283548 | n/a |
| Selection tint, current row, `<mark>`, status band, `novo` cell | `--surface-selected` | #e1f1f4 | #19333d | primary text 11.34 / 10.97; **as a state indicator alone 1.16 / 1.26, so it never stands alone** |
| Selection indicator (NEW row; no new value) | 2 px `--accent` bar or inset | #07707f | #65d6e8 | non-text: 5.78 on raised and 4.98 on selected / 9.85 and 7.80 |
| Pressed segment, active toggle | 1 px `--border-strong` ring | #78859a | #7a899f | 3.74 on raised / 4.71 |
| Text primary | `--text-primary` | #263140 | #e4eaf2 | 13.16 on raised, 12.25 on canvas / 13.85, 15.13 |
| Text secondary (meta, help) | `--text-secondary` | #4a5668 | #b6c3d3 | worst 6.32 on hover / 6.93 on hover |
| Text tertiary (counts, captions, placeholders) | `--text-tertiary` | #5a6577 | #9daabd | worst 5.01 on hover / 5.27 on hover |
| Text on solid | `--text-on-solid` | #ffffff | #0e2530 | 5.78 on accent / 9.30 on accent |
| Hairlines (decorative) | `--border-subtle` | #e3e8ee | #2a3544 | decorative, no requirement |
| Control boundaries, inputs, hatching | `--border-strong` | #78859a | **#7a899f (NEW value; today #6b7a8f)** | light ≥ 3.17 on every surface; dark today is 2.84 on hover, and the NEW value gives 3.49 on hover and 4.71 on raised |
| Accent (see the permitted uses below) | `--accent` / `--accent-hover` | #07707f / #055b68 | #65d6e8 / #8be3f1 | worst 4.91 on hover, 4.98 on selected / 7.29, 7.80 |
| Object kinds (glyph colour) | `--object-{source,note,topic,question,entity}` | #2f5fb3 #527017 #7a6200 #7048b8 #b03a79 | #8bb4f2 #a5c862 #e2b25e #b9a3f0 #ee93bd | all ≥ 4.79 light / ≥ 5.64 dark on every surface |
| Stances (glyph and stance word) | `--stance-{supports,contradicts,extends,depends-on,example-of,related}` | #1a7345 #b3261e #2a5f9e #9a4a00 #7048b8 #5a6577 | #5fd08f #f58b84 #7db4ee #f0a35a #b9a3f0 #9daabd | as text: ≥ 4.98 light / ≥ 5.26 dark on every surface |
| States (risk, health, run, done, warning) | `--state-{info,success,warning,danger}` | #2a5f9e #1a7345 #8a4b00 #b3261e | #7db4ee #5fd08f #e8b05a #f58b84 | ≥ 4.98 light / ≥ 5.26 dark |
| State tints | `--state-*-soft` | as today | as today | **not** used as highlights; only for an error or warning band |
| Rail badge (the one allowed filled count) | warning fill with raised-surface text | #8a4b00 + #ffffff | #e8b05a + #171e28 | 6.80 / 8.61 |
| Map › Grafo topic colours (**NEW** `--graph-topic-1..12`, D19; the mockup names 1-5 `--topic-cat-1..5`) | node dots and the legend only | 1-5: #3d6f9e #a0522d #3f7f4f #7d5aa6 #7f7020; 6-12 chosen by T151 under the same rules | 1-5: #8db7e0 #e39b74 #86c79a #c3a5e6 #d6c27a; 6-12 by T151 | glyph ≥ 3:1: 1-5 are ≥ 4.49 light / ≥ 7.35 dark on every surface; adjacent indices ΔE ≥ 20 *(cal.)* |
| Thread line (decorative) | **NEW `--thread`** | #cfd7e1 | #34425a | decorative; the meaning is carried by node shape and text |
| Modal scrim | **NEW `--scrim`** | rgba(22,32,48,.32) | rgba(5,8,12,.60) | n/a |

**Form separates roles that share a hue.** Hue is not enough to separate 17 roles (5 kinds, 6 stances, 4 states,
accent, text), and the tokens above are already contrast-checked. So roles that share or nearly share a hue are kept
apart by form, word and context:
- **State glyphs are solid:** filled triangle (warning), filled check (done), filled block circle (bloqueada), plus
  the running ring and the dashed idle circle.
- **Kind and stance glyphs are outline icons.**
- A stance always comes with its word, and a state always comes with its word.

Pairs that are shown together, with their CIEDE2000 difference (light / dark):

| Pair | ΔE00 | Where they meet | What separates them |
| --- | --- | --- | --- |
| topic glyph / warning | 14.9 / **2.1** | the Nutrição tree row, the Map | outline topic glyph vs solid triangle; the hidden word "grande demais"; the triangle sits after the name, the glyph before it |
| topic glyph / depends-on | 18.8 / 9.2 | relation rows (a path under a "depende de" heading) | the stance word in the heading; the topic glyph is only on the path line |
| warning / depends-on | 4.5 / 7.3 | never in the same row | context |
| question / example-of | 0 / 0 (same value) | never in the same row or list: questions are objects, "é exemplo de" is a relation heading | glyph (question mark vs framed square) and word |
| success / supports | 0 / 0 | never in the same list: "Pronta" is a Library state, "apoia" a relation | solid check vs outline ⊕; word |
| info / extends | 0 / 0 | never in the same row | word; info appears only in bands |
| related / text-tertiary | 0 / 0 | relation rows | the related glyph and the word "relacionada" |
| source glyph / extends | 3.1 / 3.2 | relation rows (evidence line under an "estende" heading) | different glyphs; the heading word |

**Accent: the permitted uses.** Accent text is either actionable or means "new since your last visit":
- links;
- the focus ring;
- the selection bar or inset;
- the one primary fill;
- "+N" in the tree, the `novo` tag, and the new-dot on a thread node.

Running values ("7 de ~18", "6 colocadas", "escrevendo") use `--text-primary` next to the running ring. A changed
setting uses a tertiary dot plus the word "Alterado" with a 2 px accent inset on the row.

**Other rules:**
- `--text-tertiary` is the quietest text allowed. There is no opacity on text and no `.dim` rule.
- Search matches use underline plus semibold, never a fill.
- A cited phrase uses `<mark>`: `--surface-selected` with a 1 px accent underline.
- **The graph reads the theme tokens.** The canvas is `--surface-raised` with `--border-subtle` frames, labels are
  `--text-primary` with a 3 px halo in the canvas colour, and edges use the stance colours with their glyph at the
  midpoint. There is no dark island in the paper theme. The dark-canvas tokens (`--graph-canvas-*`, `--graph-label*`,
  `--graph-object-*` and `--graph-stance-*`) retire with T151, and `--graph-topic-1..12` is the only graph palette.

### 4.2 Shadows and elevation (NEW)

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--shadow-sheet` | `0 1px 2px rgba(38,49,64,.06), 0 4px 16px -8px rgba(38,49,64,.10)` | `0 0 0 1px #222c3a, 0 4px 16px -8px rgba(0,0,0,.6)` | top panel, selected Inbox row, Retomar card, expanded source item, citation entry |
| `--shadow-pop` | `0 0 0 1px rgba(38,49,64,.08), 0 16px 40px -8px rgba(38,49,64,.24)` | `0 0 0 1px #34425a, 0 16px 40px -8px rgba(0,0,0,.7)` | Cmd-K, Peek, drawer, menus, context overlay, Evidence card |

Elevation never carries meaning alone: the top panel is also the only one with history arrows and actions.

### 4.3 Type

This is the app's fixed scale with no new size. Weights are 400 / 500 / 550 / 650. Serif titles are at most 550.
Tabular numerals are used for every count. Each token has exactly one line height.

| Token | Size / line height | Family | Used for |
| --- | --- | --- | --- |
| `--type-caption` | 12 / 1.5 (20 px rows; 16 in icicle cells and the Map table) | Inter | meta, counts, paths, keycaps, rail labels |
| `--type-small` | 13 / 1.5 | Inter | rows, tree, buttons, ribbon, context items |
| `--type-body` | 14 / 1.5 | Inter | default UI text; Cmd-K results |
| `--type-reading` | 16 / 1.75 | Source Serif 4 | note bodies, answers, summaries, the Inbox reason |
| `--type-lead` | 17 / 1.55 | Source Serif 4 | Home briefing, compact-panel titles, Cmd-K preview title |
| `--type-title` | 20 / 1.35 | Source Serif 4, 550 | object titles in panels, destination titles |
| (no token) number style | 20 / 1.35 (the `--type-title` size and line height) | Inter, 550, tabular | Inbox impact numbers; a component class, not a new token (§4.10) |
| `--type-display` | 24 / 1.3 | Source Serif 4, 550 | wide-sheet titles, questions, the greeting, empty-state headlines |

Titles use `text-wrap: balance`, and meta and help text use `text-wrap: pretty`. The reading measure is
`--measure: 34rem` (NEW) = 544 px. It is in rem so the cap does not change with the container's font size.

### 4.4 Spacing

The scale is `--space-1:4`, `--space-2:8`, `--space-3:12`, `--space-4:16`, `--space-5:20`, `--space-6:24`,
`--space-8:32`, `--space-10:40`, `--space-12:48` and `--space-16:64`. The index is the value divided by 4, and the
missing indices (7, 9, 11, 13-15) do not exist.

**Rhythm:**
- Paragraphs are 16 apart.
- Sections are 32 apart, with 8 from the section head to its content.
- Rows have 8-12 vertical padding.
- Panel body padding is 20/24 (`--top-pl` 24 on the top panel, 16 at compact width). Compact panels use 16.

**Rows by density:**
- **Comfortable (the default):** tree rows 28; list rows ≥ 36; table rows with 12 vertical padding.
- **Compact:** table rows with 8 vertical padding. Compact applies to the Library table and lists only. Reading
  sheets never change.

### 4.5 Radii

Use the existing `--radius-1..5` (4, 6, 8, 12, 16):
- 4: keycaps, cells, chips.
- 6: buttons, rows, fields.
- 8: tab set, segmented control, Inbox rows, generation steps box, frames.
- 12: Retomar card, generation strip, Cmd-K, Peek, menus.
- 16: pill (the full rounded end).

### 4.6 Motion

Durations are the existing `--motion-fast` 120, `--motion-base` 200 and `--motion-slow` 240 ms. Easings are NEW:
`--ease-out: cubic-bezier(.2,0,0,1)` for entering and `--ease-in-out: cubic-bezier(.4,0,.2,1)` for loops.

| What | Motion |
| --- | --- |
| Hover tints | fast |
| Panel stacking (the new panel slides 16 px and fades) | base |
| Previous panel → spine (width) | base |
| Drawer, overlay, Cmd-K, Peek and menus in | base, ease-out; out fast |
| Hover card | after a 300 ms delay, fade fast |
| Toast extension of the pill | base in, fast out |
| Running ring | 1 s linear loop |
| Skeleton shimmer | 1.4 s |
| Streaming caret | 1 s blink |
| Ask dots | 1.2 s |

### 4.7 Reduced motion

Zero the three duration tokens and add the global rule
`*,*::before,*::after{animation:none!important;transition:none!important}` under
`prefers-reduced-motion: reduce`. The ring and dots then show a static state with the same meaning. F5 follows the
macOS setting only: there is no Ajustes › Reduzir animações row (§7.6).

### 4.8 Focus

The focus ring is a 2 px `--accent` outline:
- offset +2 on buttons, links, chips and fields (outside, so it shows on filled buttons);
- offset −2 on rows, tree items, table rows and Inbox rows (inset).

Rows never also show a hover tint on keyboard focus. `#explore-focus` shows the ring on a tree row, a context row
and the Foco button.

### 4.9 Layout constants per breakpoint

These values are typed layout configuration, not `tokens.css` entries:
- one TypeScript module holds them;
- the stack's `layout()` function reads them;
- the shell writes them onto its element as the custom properties named below.

RULES.md keeps numbers in typed configuration, and §4.10 holds the token budget.

| Token | Base | ≥ 1440 | ≤ 1279 | ≤ 1179 |
| --- | --- | --- | --- | --- |
| `--rail-w` | 72 | 72 | 72 | 64 |
| `--top-h` | 48 | 48 | 48 | 48 |
| `--nav-w` | 256 | 272 | 256 | 224 |
| `--ctx-w` (docked or overlay) | 304 | 320 | 304 (overlay) | 304 (overlay) |
| `--prev-w` | 224 | 240 | 224 | 216 |
| `--spine-w` | 40 | 40 | 40 | 40 |
| `--row-h` | 28 | 28 | 28 | 28 |
| `--ind` (tree indent per level) | 12 | 12 | 12 | 8 |
| `--top-pl` / `--top-gap` (top panel padding / spine gap) | 24 / 16 | 24 / 16 | 24 / 16 | 16 / 12 |
| `--measure` | 34rem | 34rem | 34rem | 34rem |
| `--top-min` | 568 | 568 | 568 | 568 (552 at 960-999, §3) |

### 4.10 Token additions (at most 8)

`tokens.css` gains exactly these, in both themes. `npm run contrast` checks each one that carries colour.
1. `--measure` (34rem);
2. `--thread`;
3. `--scrim`;
4. `--shadow-sheet`;
5. `--shadow-pop`;
6. `--ease-out`;
7. `--ease-in-out`;
8. the `--graph-topic-1..12` family of D19 (one family, owned by T151).

One value changes: the dark `--border-strong` becomes #7a899f (3.49 on hover, 4.71 on raised).

Nothing else is added:
- the focus ring is `--accent`, with no `--focus` token;
- the number style is a class (§4.3);
- the layout values are typed configuration (§4.9).

T124 adds tokens 1-7 and the `--border-strong` value (it holds the first `tokens.css` link). T151 adds token 8 and
retires the dark-canvas `--graph-*` tokens.

## 5. Shell components

Each entry gives anatomy, then states (loading, empty, error, success), then behaviour.

### 5.1 Rail

**Anatomy:**
- The "M" mark (32, accent, serif).
- Five destinations, each an icon 20 over a 12 px word: Início, Explorar, Biblioteca, Entrada, Mapa.
- A spacer.
- Until the removals of D6, a quiet "Telas antigas" item (icon plus word). It opens a menu of the legacy views that
  are still reachable, and it leaves with the last of them (T166).
- Ajustes.

There is no theme toggle in the rail. The theme lives in Ajustes › Geral e aparência › Tema (Sistema / Claro /
Escuro) and in Cmd-K as "> tema".

**States:**
- **Active:** `--surface-selected` fill, accent icon and word, and a 2 px accent bar at the rail edge.
- **Entrada badge:** the count in a filled warning pill, with the accessible name "3 decisões esperam por você". It
  is the one filled count in the app, and it is hidden at 0.
- **Loading:** none, because the rail is static.

**Behaviour:**
- ⌘1-⌘5 go to the destinations, and ⌘, opens Ajustes.
- `aria-current="page"` marks the active destination.
- The rail is never icon-only.

### 5.2 Top bar

**Anatomy:** a grid `[name 200] [omni, max 480] [1fr] [status slot] [Adicionar]`.
1. The destination name (14, 550). It is the same element on every screen, so the omni trigger starts at the same
   x everywhere, including first run.
2. The omni trigger (32 tall): search glyph, "Buscar, abrir ou perguntar…" and the ⌘K keycap.
3. The status slot: right-aligned, max width 420. It truncates inside the pill and never reflows the bar.
4. Adicionar, a split button (secondary, outlined): the main part "+ Adicionar", a hairline divider, and a 24 px
   chevron.

**Status slot, normal: the Activity pill.** The pill names the work, never just "ativo":
- "[ring] **Gerando** 1 fonte · 3 em espera | [solid triangle] 3 precisam de você"
- "[ring] Jardineiro conferindo conexões em Teoria musical"
- "[solid check] Tudo em dia"
- "Pausado: o Mac está na bateria"

Rules:
- The needs-you clause is always in words.
- On Home the needs-you clause is dropped, because the "Precisa de você" column shows it.
- The tooltip and accessible name hold the full sentence. A pill that names the Jardineiro also explains it once:
  "O Jardineiro é o trabalho em segundo plano do Memora: arruma a árvore e as conexões, sempre com Desfazer."
- At compact width the "em espera" clause drops first.
- Click or ↵ opens the drawer, with `aria-expanded`.

**Status slot, after an action (8 s): the undo toast as an extension of the pill.**
- The pill's left part turns into "✓ Nutrição dividida em Micronutrientes e Padrões alimentares · ↶ Desfazer U". The
  toast says the verb and the object. The right part keeps "2 precisam de você".
- `role=status`, announced politely.
- U works while it is shown, unless focus is in a text field. F6 reaches it.
- It returns to the pill after 8 s or on the next action. The action stays undoable from the object's Histórico and
  from Atividade › Desde a sua última visita.
- The action is also confirmed **in place**: the item moves to "Resolvidas hoje" with a new-dot, "agora" and an
  inline Desfazer (`#inbox-relation` shows this moment).
- Toasts never float over content.

**Adicionar** (`#add-menu` shows the menu open):
- **The main part opens the file picker.** Dropping files anywhere in the window does the same (`#drop`), and ⌘N
  opens it from any screen.
- **The chevron opens a menu:** "Escolher arquivo… ⌘N", "Colar link" ("uma página da web ou um vídeo") and "Escrever
  uma nota" ("vai para Sem lugar até ganhar um tópico"). Its last item, "Mais opções de importação…", opens the
  advanced import panel (D32).
- **The menu's "Ao importar" group** sets the import mode (radio):
  - Segundo cérebro: "notas curtas, lugar na árvore e conexões";
  - Pesquisável e organizado: "trechos para busca e lugar na árvore, sem notas";
  - Só guardar: "o arquivo fica na Biblioteca, sem IA".

  The default follows the plan: Segundo cérebro when a model that can write is ready ("recomendado: há um modelo
  pronto para escrever"), otherwise Pesquisável e organizado. The foot reads "Vale para as próximas importações;
  cada fonte pode mudar depois."
- **After the picker closes**, the new Source is pushed onto the Explore stack and the app switches to Explore. The
  generation strip and the first "Procurando lugar na árvore…" row show at once (`#first-import`). With several
  files, the first one opens and the others wait in the pill. There is no "Abrir" toast (amendment A7).
- **Error** (unreadable file): the Source still opens and its generation strip shows the error with "Tentar de novo".
  There is never a modal.

### 5.3 Navigator

**Anatomy, top to bottom:**
1. The filter field ("Filtrar árvore", `/` focuses it).
2. Fixados.
3. Árvore: the title, the total "412 notas", and the legend line "**+N** = novas desde ontem, 22:40".
4. Recentes (2-5 rows).
5. The foot: "Sem lugar · 3 notas · 2 fontes" (Unsorted, with nouns).

**Tree rows** are 28 tall with an indent of `--ind` per level (12; 8 at compact width). Each row has:
- a chevron (16);
- the kind glyph (16, kind colour);
- the name (13);
- a health glyph when needed (a solid warning triangle with the hidden word "grande demais");
- "+N" in accent on collapsed rows only, meaning new since the last visit (aggregated, §18);
- the count (12, tertiary). At compact width it shows only on hover, focus and the open row.

**Fitting a name** (the mockup's `fitTree`):
1. Drop "+N" and tags first.
2. Then drop the count (except on the open row).
3. The open row, its ancestors and a tentative row wrap instead of being cut in the middle. Ancestors and topics
   always fit in 2 lines. A long leaf title is clamped at the end of its second line, after its last whole word, and
   the ribbon above the title always has it in full.
4. Any other row is cut **only at word boundaries, never inside a word**, keeping the distinguishing end:
   - first, whole head words, then "…", then whole tail words ("Microbiologia…cap. 3", "Temperatura…final");
   - when not even one head word fits beside the tail, a leading "…" keeps the tail words ("…alcoólica");
   - when the last word alone does not fit, the end is cut with an ellipsis (the CSS tail ellipsis is the last
     resort).

   The mockup's `fitTree` cuts inside words ("Fermentaç…alcoólica", "Microbiologi…ap. 3"). That is a known defect of
   the mockup, and this rule binds (orchestrator review, gate D). The same rule applies to every list label in the
   app: Fixados, Recentes, the Library, Cmd-K, the Inbox and the Map table.
5. "mais N notas" rows are never cut.
6. The full name is in the tooltip, in the row's accessible name, and in the 300 ms hover card, on hover and on
   keyboard focus.

**Leaves.** Notes and sources are leaves under their topic. Under the topic of the open object the tree shows a
window, not the list: the open leaf, its two neighbours and "mais 15 notas". When the topic itself is the open
panel, its leaves fold into one row, "18 notas no painel" (`#topic`). The Topic page is the list; the tree's job is
position.
The open object is highlighted (`--surface-selected`, the 2 px accent bar and `aria-current`), and its ancestors are
semibold.

**Tentative leaves.** Questions are not tree leaves in F5: the plan's tree lists notes and sources. A source still
generating sits under its probable topic
with an italic name, a dashed underline and an outlined "provável" tag on its own line. Its ribbon says the same
(§9). It moves to its final topic when the notes are placed. It never also appears under Sem lugar.

**Hoist (only this branch).** "Mostrar só este ramo" in a topic's menu, or the same Cmd-K action, makes that topic the root of
the tree. A sticky breadcrumb at the top of the navigator reads "‹ Árvore inteira · Ciências da vida ›", followed by
the hoisted topic with its count. The tree title reads "Ramo · 54 notas". The breadcrumb returns. (There is no ⌥→ /
⌥← key: `rules/frontend.md` reserves Option-Arrow for text editing.) The
breadcrumb stays at the top while the tree scrolls. Hoist is per window and is saved with the stack. The `#states`
board shows the frame at 224 px.

**States:**
- **Loading:** 8 skeleton rows at staggered widths.
- **Empty:** a dashed box reading "**Os tópicos nascem sozinhos.** Quando a primeira fonte virar notas, a árvore
  aparece aqui. Você não precisa criar pastas." Fixados then reads "Fixe o que você abre sempre: ⌘D no painel
  aberto."
- **Error:** "Não foi possível carregar a árvore. Fixados e Recentes continuam aqui." with "Tentar de novo".
- **Filter with no result:** "Nada com “x” na árvore." with "Buscar em tudo ⌘K".

**Behaviour:**
- ARIA tree with arrows, Home/End, →/← to expand or collapse, and typeahead.
- ↵ opens beside, ⌥↵ opens in the focused panel, and Space or ⌘Y peeks.
- The tree follows the top panel: it expands to the open object and scrolls to it.
- ⌘\ hides or shows the navigator.

### 5.4 Panel

**Header** (40):
- kind glyph plus kind word (13, secondary);
- the per-panel ‹ and ›, each shown only when that history exists. At the start of the history, ⌘[ closes the panel
  and ⌘] reopens it (D8);
- a spacer;
- on the top panel of **every kind** (Topic, Source, Note, Question, Entity): "Foco" (icon plus word), the pin icon
  (tooltip "Fixar no navegador (⌘D)") and × close (tooltip "Fechar painel (⌘W)"). Each icon-only control has its
  tooltip text as its accessible name.

The previous panel shows only its kind and ×. In focus mode, "Foco" becomes the pressed indicator "Modo foco · Esc
sai".

**Body:** the object page (§6). The ribbon sticks to the top of the body once scrolled.

### 5.5 Spine

A 40 px button on the desk colour. Reading top to bottom, it shows:
- the kind glyph (16, kind colour);
- the kind word, then the title, in `writing-mode: vertical-rl`: "Fonte · Microbiologia dos alimentos, cap. 3" (13;
  the kind word is tertiary; ellipsis at the end).

**Accessible name and tooltip:** "Fonte: <título>. Reabrir painel", followed by where it came from, for example
"aberta pela Biblioteca" or "você lia esta nota e perguntou pelo ⌘K". This keeps the stack readable as a trail.

**Behaviour:** hover uses `--surface-hover`, and click or ↵ re-expands it (§8). Forward spines (§8 rule 5) sit at the
right of the top panel, left of the context panel; `#topic` shows one. The "+N" spine reads "+3 · mais antigos" and
opens a list of the hidden panels ("3 painéis mais antigos").

### 5.6 Context panel

The context panel sits on the desk colour and follows the top panel.

**Header** (40, the same line as the panel headers): one row of worded tabs (`role=tablist`), priority+.
- Three tabs are shown: Conexões, Evidência and Perguntar.
- "Mais ▾" holds Menções, Grafo and Histórico.
- When a tab from "Mais" is chosen, it takes the third slot, so the selected tab is always visible.
- The selected tab has a 2 px accent underline and primary text; the others are secondary.
- Arrow keys move along the row, and ⌥1-⌥6 jump to a tab in the order Conexões, Evidência, Perguntar, Menções,
  Grafo, Histórico. They are matched by key code and never fire inside a text field or editor, where Option-digit
  types a character.
- The six tabs are D31's. Histórico is D31's "Activity" tab (the object's change-sets with Undo). It is renamed so
  that "Atividade" names only the global pill and drawer (§13).

**Body heading:** each tab's body starts with a title and a one-line description:
- "Conexões desta nota · Como esta nota se liga a outras, e quem decidiu. 5 conexões · 1 sugestão."
- "Evidência desta resposta · As fontes citadas, na ordem dos números."
- "Menções · Onde este objeto é citado sem uma conexão."
- "Histórico · Tudo o que mudou neste objeto, com Desfazer."
- "Perguntar a esta fonte · A resposta usa só os trechos deste livro e cita cada um."

**Default tab** (the last tab the user chose for each kind is remembered):

| Top object | Default tab | Why |
| --- | --- | --- |
| Note | Conexões | the body shows a summary; the tab is the full list |
| Source while generating | Perguntar | the strip already shows progress; asking is the new thing it can do |
| Source when ready | Conexões | |
| Question | Evidência | the sources list that the chips expand into |
| Topic | Conexões | |
| Entity | Perguntar | its mentions are already the page body |

**Tabs:**
- **Conexões:**
  - Groups are headed with the stance glyph and a directional phrase in the stance colour: "Apoiam esta nota",
    "Esta nota estende", "Esta nota depende de", "Esta nota é exemplo de", "Contradiz esta nota".
  - Each row shows the title (13, wraps), then the **path line** (topic glyph plus crumbs; deep paths keep the last
    2 crumbs after "…"), then the meta "Jardineiro · confiança alta · ontem, 23:14" or "você ligou · 2 nov".
  - Suggestions sit in a dashed box with "Manter A" and "Remover ⌫". The box reads "decida quando quiser" (an inline
    suggestion) or "também na Caixa de entrada" (a routed one, see below).
  - The foot reads "Ver no Grafo · Ver como tabela".
- **Evidência:** the passages behind the top object, numbered as in its body. For a Question it is the sources list
  (§10.3).
- **Perguntar:** Ask scoped to the top object ("Perguntar a esta fonte / a este tópico"), with "Já dá para
  perguntar: os 210 trechos estão indexados" while the notes are still being written. Only D14's scopes exist
  (library, topic and source), so:
  - a note asks its primary topic ("Perguntar sobre <tópico>, onde esta nota está");
  - an entity or a question asks the whole library, and an entity prefills its name.

  The scope is always written.
- **Menções:** objects that mention this one, grouped by kind.
- **Grafo:** for a note, the DOI ego-graph, which reads tokens (§4.1), with two-line labels on a halo. "Ver como
  lista" switches to Conexões. `objects.neighborhood` stays notes-only (D11), so for other kinds the tab shows the
  stance legend and "Abrir no Mapa › Grafo", scoped to the object (T143). The mockup's topic ego-graph in `#topic` is
  not built in F5.
- **Histórico:** this object's thread with Desfazer. The global drawer is "Atividade"; the per-object tab is never
  called that.

**Routing rule for suggestions.** A suggested relation at medium risk or above (confidence below "alta", or the
stance "contradiz") goes to the Caixa de entrada and also shows inline. It counts in "precisam de você", and its
inline box reads "também na Caixa de entrada". A low-risk suggestion shows inline only and reads "sugestão do
Jardineiro · decida quando quiser". It is never counted as needing the user.

**Relations in the note body.** While the context panel is docked, the note body shows a **summary** of its
Conexões: one chip per stance with its count ("2 apoiam", "estende 1", …, "1 sugestão") and "A lista completa, com o
caminho de cada nota, está ao lado em Conexões." When the context is a strip or hidden (compact width, focus mode),
the body shows the **full list**. Relations are therefore never shown twice side by side.

**States:**
- **Loading:** 4 skeleton items under the tabs.
- **Empty that teaches:** for Conexões, "Ainda sem conexões. O Jardineiro procura quando o Mac está ocioso." with
  "Ligar a outra nota" and the six-stance glyph-and-word legend.
- **Error:** "Não foi possível carregar as conexões. A nota continua aberta." with "Tentar de novo".

**At ≤ 1279:** a 40 px strip with "Contexto · Conexões · 5" written top to bottom. A click or ⌘⇧\ opens a 304
overlay with a pop shadow over the top panel's right edge. While it is open, the strip shows the selection inset.
Esc, the strip or a click outside closes it (`#explore-ctx`).

### 5.7 Thread

One grammar is used everywhere the system acts: the Home digest, the Activity drawer, the object's Histórico, the
Map's "A forma nesta semana" and the first-run promise.

- **Line:** 1 px `--thread`.
- **Nodes:** filled tertiary = done; accent ring with halo = running; hollow strong border = waiting; solid warning
  = needs you; accent filled = new since the last visit.
- **Row:** a 13 px sentence with inline kind glyphs and object names as links, then 12 px meta, then a right column
  with the time and "↶ Desfazer".
- **Sentence templates** (one per change type, the same in every screen, built from the fixture record):
  - **Created:** "Criou <tópico> em <pai> e moveu N notas de <pai> para lá".
  - **Linked:** "Ligou <título exato da origem> <glyph> <verbo> <título exato do destino>". The direction is always
    source → stance verb → target, the same as the Evidence card. Example: "Ligou No séc. XIX, sal e acidez
    conservavam alimentos sem gelo ⊕ apoia O ácido lático inibe patógenos ao baixar o pH".
  - **Renamed:** "Renomeou “<antigo>” para <novo>", with the meta "o nome antigo continua valendo na busca".
- **States:**
  - **Loading:** 3 skeleton rows.
  - **Empty:** "Nada foi alterado automaticamente ainda." (the existing key).
  - **Undo blocked:** "Não dá para desfazer agora: uma mudança posterior depende dela." (the existing key) in place
    of the link.

### 5.8 Activity drawer

**Anatomy:** a non-modal 400 wide sheet, right, below the top bar, with a pop shadow. The header reads "Atividade ·
o que o Memora faz em segundo plano" with ×. The sections use the existing i18n keys:
- **Agora:** "1 · um trabalho com modelo local por vez". **At most one row uses the local model.** A row has a ring
  node, the object and step, "escrevendo notas · 7 de ~18 · faltam ~3 min · modelo local", a 4 px bar and Pausar.
  Cloud or no-model steps may run beside it, each on its own row.
- **Em espera:** every row carries "motivo: …". Contention for the local model is always a waiting reason:
  "Jardineiro: conferir conexões em Teoria musical · motivo: espera o modelo local ficar livre · 12 de 30 conexões
  conferidas antes". Other reasons are "espera as notas terminarem" and "só roda com o Mac na tomada · mudar".
- **Precisa de você:** "3 decisões na Caixa de entrada · 1 bloqueada · a mais arriscada: Dividir Nutrição em dois
  tópicos" with "Abrir ⌘4".
- **Desde a sua última visita** ("ontem, 22:40 · 9 mudanças do Jardineiro, todas reversíveis"): one row per change,
  each with a time and Desfazer. An import row has "Remover a fonte" instead, because an import is undone by removing
  the source. A row that cannot be undone shows the blocked reason (§5.7).
- **Orçamento:** "IA na nuvem este mês: US$ 1,80 de US$ 15,00" with a bar, "Trabalho em segundo plano hoje: 34% da
  cota", "Modelos locais não têm custo." and "Ajustar limites em Ajustes › IA".

**States:**
- **Loading:** a skeleton per section.
- **Empty:** "Nada está em execução agora." For waiting and needs-you, use the existing empty keys, and hide the
  section when the whole drawer is calm.
- **Error:** "Não foi possível carregar a atividade." with "Tentar de novo".

**Behaviour:** Esc closes the drawer and focus returns to the pill. Links inside navigate, and the drawer closes when
the user changes destination.

### 5.9 Cmd-K

See §11.

### 5.10 Peek and hover card

See §10.

### 5.11 Controls

- **Buttons** are 32 tall (28 small):
  - primary: accent fill and on-solid text, one per screen;
  - secondary: raised background with a `--border-strong` outline;
  - quiet: no border and secondary text;
  - link: accent text.
- **Split button** (Adicionar): a secondary button with a hairline divider and a 24 px chevron part. Each part has
  its own focus ring and accessible name ("Adicionar fonte", "Mais formas de adicionar").
- **Keycaps** are 12 px, 20 tall, with a soft fill and a strong bottom border. On a primary button they are outlined
  in on-solid.
- **Segmented control:** a soft track. The pressed chip is raised, semibold and ringed with `--border-strong`, and
  uses `aria-pressed`.
- **Tabs:** worded, with a 2 px accent underline for the selected tab.
- **Text inputs** use a `--border-strong` boundary (3:1). The omni trigger may use subtle, because its glyph, text and
  keycap identify it.
- **Tags** are 20 tall, outlined, and never filled. "novo" uses an accent outline, and "provável" uses a dashed
  strong outline.
- **State words**, always glyph plus word, with solid state glyphs:
  - Pronta: solid check;
  - Gerando: running ring;
  - Precisa de você: solid triangle;
  - Bloqueada: solid block circle;
  - Guardada, sem notas: dashed circle, tertiary, with "Gerar notas".
- **Risk glyph:** a 3 / 2 / 1 bar meter always paired with Alto / Médio / Baixo (danger, warning, secondary).
  Bloqueada uses the solid block circle instead and is sorted above all risks.
- **Confidence** is written as a word: "confiança alta" (≥ 0.85), "confiança média" (0.6-0.85) or "confiança baixa"
  (below 0.6). The bounds are typed configuration. The UI never hides a relation by confidence: only
  `note-relation-sql.ts` decides what is shown (D11). Cards and the Inbox add the percentage: "confiança média
  (64%)".

### 5.12 Loading, empty and error grammar

- **Loading:** skeleton bars in the shape of what comes, shown only after 150 ms. No spinner, except the running ring
  for live work. Nothing else uses grey bars: the Retomar card and every miniature use real text.
- **Empty:** a dashed `--border-strong` outline and a sentence that teaches the next action, with the action itself.
  Empty never looks like loading.
- **Error:** a plain sentence saying what failed, what is kept, and "Tentar de novo". It is shown in place, never as
  a modal and never with `window.alert`.
- **Time:** relative times ("agora mesmo", "faltam cerca de 3 min") are computed when the view renders and refresh on
  the next pushed event. No timer ticks them (D16: no `setInterval` and no polling). A start time is written as an
  absolute time ("desde 09:12").

The `#states` board shows each of these for the navigator (including hoist and a filter with no result), a panel
(loading, error, merged object, history), the context panel, the "+N" spine list, Home (loading, calm day), Cmd-K
(slow, no result, index rebuilding), a blocked undo, generation (an error at a step, needs you) and an empty
Caixa de entrada.

## 6. Object pages

Every page puts the same regions in the same order: ribbon → title → meta → body regions. The layout never depends on
the kind, and every top panel has Foco.

All five kinds share three states:
- **Loading:** a skeleton ribbon, title and three body lines.
- **Error:** "Não foi possível abrir esta nota. O resto do Explorar continua aberto." with "Tentar de novo · Fechar
  painel".
- **Gone:** "Esta nota foi juntada a <link> em 9 nov." with "Abrir a versão atual".

### 6.1 Topic (`#topic`)

**Full page:**
- **Ribbon:** the ancestors. The leaf is the parent, in regular weight.
- **Title:** 20 in a panel, 24 on a wide sheet.
- **Meta:** "18 notas · 2 fontes · ✓ tamanho equilibrado". The health alternative is "▲ grande demais (7 subtópicos
  diretos; o limite é 6) · Ver proposta".
- **Visão geral** (lazy):
  - loading: 3 serif skeleton lines;
  - success: serif paragraphs with citation chips;
  - stale: "Visão geral de 3 dias atrás · Atualizar";
  - error: with retry.
- **Subtópicos:** rows with count and +N.
- **Notas:** titles wrap to 2 lines; sort by Recentes or Relevância.
- **Fontes** and **Perguntas aqui**.
- **Context default:** Conexões. `#topic` shows the Grafo tab with the ego-graph and a forward spine on the right.

**Compact form** (previous panel): the ribbon at 12 px, the title at lead 17, the meta, a 2-4 line serif overview,
and the notes list with the current row highlighted (`aria-current`, 2 px accent inset).

**Empty topic:** "Ainda sem notas diretas. As notas estão nos subtópicos abaixo."

### 6.2 Source (`#source`, `#first-import`)

**Ribbon:** placed, or tentative: "Lugar provável: <dashed path> · definido quando as notas terminarem" (§9).

**Meta:** "Artigo · R. Andrade e L. Quispe (2023) · Revista de Estudos Urbanos, v. 12 · 24 páginas · adicionada hoje,
09:12".

**Live generation strip** (while processing; it replaces the old Jobs screen). It sits in a 12-radius box on the desk
colour:
- **Header:**
  - the running ring with "Gerando conhecimento desta fonte";
  - "desde 09:12 · faltam cerca de 3 min · modelo local, sem custo";
  - the milestone line "Já dá para perguntar a esta fonte: os trechos estão indexados." (a link);
  - Pausar.
- **Steps:** Lida, Trechos, Notas, Na árvore, Resumo, Conexões. Each step has a node of the thread grammar, a word and
  a value ("24 páginas", "142 buscáveis", "7 de ~18", "6 colocadas", "escrevendo", "depois das notas"). Running
  values are `--text-primary`. At compact width the steps lay out in 3 columns × 2 rows.
- **Section ruler:** a caption above it reads "Notas por seção do texto". It has one segment per section, with width
  proportional to length: done is filled tertiary, the section being read is accent-hatched, and pending is soft.
  Section names sit under the segments and may wrap to 2 lines.
- **Done:** the strip collapses to one line: "Pronta em 4 min · 18 notas · 12 conexões · Ver no Histórico".
- **Error at a step:** a "!" node, the reason and the next step: "Não deu para ler a página 12 (PDF protegido) · Pular
  página · Tentar de novo".
- **Needs you:** "Idioma não detectado · Escolher idioma".
- **Paused:** "Pausada por você · Retomar".
- **Mode "Pesquisável e organizado":** the Notas, Resumo and Conexões steps read "não se aplica neste modo", and
  "Gerar notas" sits at the right.

**Inline teaching hint** above the notes: "As notas aparecem aqui assim que ficam prontas, já com o caminho na árvore.
Clique numa para abri-la ao lado; Espaço espia sem abrir." On `#first-import` the hint also introduces the
Jardineiro: "Cada nota aparece aqui com o caminho na árvore, e a árvore nasce à esquerda. Depois, o Jardineiro arruma
a árvore e as conexões em segundo plano, sempre com Desfazer."

**Notas:**
- Newest at the top: "Notas · 7 até agora · as mais novas no alto".
- Each row shows the title, then the **full path** (topic glyph plus crumbs), then a "tópico novo" tag when the
  placement created a topic, then the section.
- The newest row carries an accent new-dot and "agora mesmo" at the right. It has no fill, because a fill means
  selection. Its path reads "Procurando lugar na árvore…" with the ring until it is placed.
- One skeleton row stands for the next note.
- Click opens the note beside; Space peeks.

**Resumo:** a streaming serif summary with a caret.

**Context default:** Perguntar while generating, Conexões when ready.

**Deferred:** underlined source passages with margin-anchored notes (A) wait for a spike. F5 shows the section and a
"Ver o trecho" link that opens `#passage`.

### 6.3 Note (`#explore`, `#note`, `#note-rel`)

**Narrow panel** (Explore): ribbon (path plus "também em"), title 20, meta ("Escrita pela IA local em 3 nov · revisada
por você em 5 nov · 2 fontes"), then:
- prose: serif 16 / 1.75 in the reading measure, with accent superscript footnote numerals;
- **Evidência:** numbered quotes in italic serif 14, with the cited phrase in `<mark>` and "fonte · p. 47";
- **Conexões:** the summary chips while the context is docked, the full list otherwise (§5.6);
- **Histórico.**

**Wide sheet** (focus mode, or a panel ≥ 760 wide; a container query, not a mode):
- **Text column:** max 600, holding the ribbon, display 24 title, meta and prose.
- **Margin:** 264, separated by a 48 gap and top-aligned with the ribbon. It holds **Evidência** in reading order.
- **Conexões** sits below the text column, one row per relation in reading width:
  - Column 1: the stance glyph and a directional phrase in the stance colour ("apoia esta nota", "esta nota
    estende", "esta nota depende de", "esta nota é exemplo de").
  - Column 2: the related note and its full path.
  - Column 3: "Jardineiro · confiança alta" over "explicação escrita pela IA local".
  - Suggestions are dashed rows with "Manter A" and "Remover ⌫" and the routing phrase (§5.6).
  - Above the list: "Ligar a outra nota".
- The margin beside Conexões is reserved for the **Evidence card** (§10.1).
- Then **Histórico** (a thread with Desfazer). The margin beside it holds:
  - "Lugar na árvore": "Colocada em Fermentação lática pelo Jardineiro em 3 nov, confiança alta (93%). Por que aqui?
    · Mover…";
  - Entidades;
  - "Endereço: memora://note/… · Copiar link".

**Margin and spacing rules:**
- Margin blocks never change paragraph spacing.
- Below 760 the margin folds into the body in the same order and with the same look.

**Note states:**
- **Draft:** "Escrevendo…" with a caret.
- **Evidence missing:** "Sem trecho de origem. Esta nota foi escrita por você." (no warning colour).
- **Superseded:** a banner reading "Há uma versão mais nova" with "Abrir".

### 6.4 Question (`#ask`, `#passage`)

**Ribbon:**
- **While streaming:** "Lugar: sai das citações quando a resposta terminar". There is no path yet, because citations
  are stored on completion (D14).
- **When done:** "<path> · colocada pelas citações", the path that `objects.locate(question)` returns.
- **Topic scope:** a topic-scoped question keeps its scope topic's path ("<path> · escopo do tópico").

The question's place is read, never written: it is the topic where most of its cited notes are primarily placed (a
spec change to section 3.3 and T129, §20.3 S4). A question is not a tree leaf in F5.

**Title:** the question at display 24 on wide sheets and title 20 in panels.

**Meta:** "Perguntada agora, pelo ⌘K · escopo: toda a biblioteca · IA na nuvem".

**Status band** (`--surface-selected`, exactly the reading measure):
- One line per D14 stage, never coalesced:
  - retrieving: "**Lendo a biblioteca** · 14 trechos de 6 fontes";
  - answering: dots, "**Escrevendo a resposta** · 4 de 6 fontes lidas", "Parar Esc";
  - waitingForProvider: "**Esperando a IA na nuvem responder** · a resposta continua daqui";
  - failed and canceled: as in the states below.
- Done: "Respondida em 11 nov · 6 fontes · Refazer". Refazer is D14's "Ask again", which makes a new version.
- Stale (computed on read): "Pode estar desatualizada: uma fonte citada mudou depois da resposta · Refazer".

**Answer:**
- Streamed serif paragraphs with citation chips (§10.3).
- "Salva em Perguntas. O lugar na árvore sai das citações quando a resposta terminar. Cada citação leva ao trecho
  exato."
- A follow-up field, exactly the reading measure: "Seguir perguntando, no mesmo escopo… ↵".

**Ask scopes** (one rule for the four ways in):
- The omni trigger with "?" or the "Perguntar" result asks the whole library.
- The Perguntar tab asks the top object's scope (§5.6).
- "Já dá para perguntar a esta fonte" opens that tab.
- "Seguir perguntando" keeps the scope of the answer it follows.

The scope is always written in the meta line.

**Context default:** Evidência ("Evidência desta resposta"):
- "Escopo: toda a biblioteca · 14 trechos lidos de 6 fontes";
- a numbered list matching the chips (kind glyph, title, locator);
- the reading states "lendo…" (skeleton) and "na fila";
- "Lidas, não citadas (2)" with the reason ("não trazia nada sobre conservação").

**Passage landing (`#passage`).** Clicking a chip, or ↵ on a sources entry, opens the source beside the question,
scrolled to the passage, with the cited sentence in `<mark>`. A banner on the source reads "Aberto pela citação 1 de
“Por que alimentos fermentados…”" with "Voltar à resposta ⌘[". The context switches to "Evidência desta fonte".

**States:**
- **No grounding:** "Não achei nada na sua biblioteca sobre isso." with "Reformular? · Adicionar uma fonte".
- **Route error:** keep the partial answer and show "A rota de IA não respondeu." with "Tentar de novo · Usar outra
  rota".
- **Stopped:** "Parada por você · Continuar".

### 6.5 Entity (`#entity`)

- **Ribbon:** "mais citada em Ciências da vida › Microbiologia" (its densest topic).
- **Title:** the entity glyph and its name.
- **Meta:** the kind (pessoa, organismo, lugar…) and "citada em 11 notas · 4 fontes".
- **Body:** Menções grouped by topic, Aliases and Fontes.
- **Context default:** Perguntar (the whole library, with the name prefilled, §5.6).
- **Empty:** "Ainda sem menções diretas."

## 7. Destinations

### 7.1 Home (`#home`)

Home is shown on the first open of the day and on first run (D9). Otherwise the app opens on the last place. The data
is `home.digest({ since: lastHomeOpenAt })` (T130), plus two fields the briefing needs (§20.3 S5): the Jardineiro's
change-sets since then and the unplaced count.

**Brief band, left:**
- The date line: "Quarta-feira, 11 de novembro · última visita ontem, 22:40".
- The greeting (display 24 serif): "Bom dia. Enquanto você esteve fora:".
- The briefing (lead 17 serif), with linked counts in accent.
- The reassurance line with a shield glyph: "Nada foi apagado. Cada mudança tem Desfazer e fica no histórico do
  objeto."

**Briefing clauses.** Each clause has a truth condition and is dropped when its count is zero.

| Clause | Shown when | Text (fixture values) |
| --- | --- | --- |
| Arrivals | arrived ≥ 1 | "Chegaram **3 fontes** e já viraram 30 notas;" |
| Placement | always with arrivals | unplaced = 0: "todas com lugar na árvore."; otherwise "29 já têm lugar na árvore e 1 ainda procura." |
| Generating | a source is generating | "Uma fonte ainda está gerando notas." (never "sendo lida" once reading is done) |
| Gardener | changes ≥ 1 | "O **Jardineiro** fez **9 mudanças**, todas reversíveis." ("Jardineiro" carries the explanation tooltip) |
| Decisions | needs-you ≥ 1 | "**3 decisões** esperam por você, entre elas dividir Nutrição em dois tópicos." (the canonical title) |

**Brief band, right: the Retomar card.** It reads "Continuar de onde parou · ontem, 22:38". Below that is the trail
as three plain rows on a thread: kind glyph, kind word, and the serif title ("Fonte · Microbiologia dos alimentos,
cap. 3", "Tópico · Fermentação lática", "Nota · O ácido lático inibe patógenos ao baixar o pH"). The foot reads "3
painéis em Explorar", next to the **only primary button**, "Retomar ↵". There are no grey bars.

**Shape strip** (the plan's Shape lens on Home): "Sua árvore · 412 notas em 38 tópicos". It has one segment per root
topic, with width proportional to notes, a full-width bar and two-line labels ("Ciências da vida 128"). A topic that
is too big has a solid warning triangle and a warning outline. At the right: "▲ 1 tópico grande demais · Ver no
Mapa".

**Columns.** Every column header uses one pattern: the title, then the meta on a second line, and the link at the
right of the title.
- **Precisa de você** ("bloqueios primeiro, depois por risco" · Caixa de entrada): Bloqueada first, then by risk.
  Each row shows the risk glyph and word, the canonical title, and the kind and impact ("estrutura · 85 notas com
  caminho novo"). Inbox keys are taught in the Inbox, not here.
- **O que o Jardineiro fez** ("9 mudanças, com o Mac ocioso, todas reversíveis" · Ver todas): 3 thread rows built
  from the templates in §5.7, each with Desfazer, and "Por quê?" on the first.
- **Chegou** ("3 fontes · 30 notas" · Biblioteca): each source row shows its path and note count. A source in
  progress shows "gerando notas" with a mini bar and "7 de ~18".
- **Para relembrar** ("1 nota que você não vê há um mês" · Ver mais): one resurfaced note with a reason ("vista há
  34 dias · 2 conexões novas com …") and Abrir · Mais tarde · Não mostrar de novo.

  **Not in F5:** no resurfacing schedule exists yet. F5's fourth column is **Perguntas recentes**
  (`home.digest.questions`: the last 3, each with its scope and date), in the same column pattern.

**States:**
- **Loading:** a skeleton briefing (3 lines) and columns.
- **Calm day:** "Bom dia. Nada mudou desde ontem." with "Sem fontes novas, sem mudanças do Jardineiro e nada
  esperando por você.", then Retomar and Perguntas recentes.
- **Error per section:** retry.
- **First run:** §7.7.

### 7.2 Explore

This is the three-zone workspace (§3, §5, §8). The mockup shows its states as hashes: `#explore`, `#note`,
`#note-rel`, `#source`, `#ask`, `#passage`, `#topic`, `#entity`, `#activity`, `#cmdk`, `#add-menu`, `#keys`,
`#explore-focus`, `#explore-ctx`, `#first-import` and `#empty-explore`.

### 7.3 Library (`#library`, `#peek`)

**Header:**
- "Biblioteca" (title 20 serif);
- the tabs Fontes | Perguntas (T149). The Perguntas tab lists saved questions with scope, date and citation count in
  the same table grammar;
- "48 fontes · 412 notas";
- the density toggle Confortável / Compacto. It is the only density control in F5. Its value is a per-device
  convenience kept in `memora.workspace.v1` (D8), not a setting: the Settings v2 proposal leaves density out.

**Bar:** the filter field ("Filtrar por título, autor ou tópico", `/`) and state chips (segmented, with counts):
Todas 48, Gerando 1, Precisa de você 1, Sem notas 3.

**Territory bar:** "Por área:" followed by each root topic and its count, then "Sem lugar 2 fontes". The counts add
up to 48.

**Table:**

| Column | Content |
| --- | --- |
| Fonte | glyph, title, then format · authors · size |
| Lugar na árvore | the last 2 crumbs, with "…" when deeper; "provável:" and a dashed underline when tentative; or "Sem lugar" |
| Notas | right-aligned, tabular |
| Estado | glyph + word, with a second line giving the reason when it needs you; "Guardada, sem notas" with "Gerar notas" |
| Adicionada | the date |

- **Sorting:** the headers are buttons with `aria-sort`. The default is Adicionada, newest first, shown with an arrow
  on that header.
- **Selection:** the selected row has the tint and the 2 px accent bar.
- **The table is virtualized.** The foot reads "↑↓ escolher · Espaço espiar · ↵ abrir ao lado · 48 fontes · as mais
  novas primeiro". There is no paging text.
- **Keys:** ↑↓; Space or ⌘Y to peek; ↵ to open the Source beside the table, in the Library's own stack (D8, §8 rule
  8). The table then shows as the compact previous panel (titles, with the current row marked) or as a spine.
- **Compact width:** the Adicionada and Notas columns drop. Estado and Fonte never drop, and the page never scrolls
  horizontally at 960.

**States:**
- **Loading:** 8 skeleton rows.
- **Empty:** "Nenhuma fonte ainda." with the drop zone (§7.7).
- **Filtered empty:** "Nenhuma fonte com esse filtro · Limpar filtro".
- **Error:** with retry.

### 7.4 Caixa de entrada (`#inbox`, `#inbox-relation`)

**List:**
- "Caixa de entrada" and "3 decisões · bloqueios primeiro, depois da mais arriscada para a menos".
- **Bloqueada** comes first ("precisa de você para continuar"), with a solid block glyph. It holds quick inputs
  without which work stops: "Escolher o idioma de aula-04.txt · fonte · sem isso, a fonte não vira notas".
- Then the risk groups, headed with the meter and "Risco alto / médio / baixo".
- Each row has a canonical title (wraps), a subtitle when needed ("em Micronutrientes e Padrões alimentares"), a kind
  word at the right (estrutura, conexão, fonte) and meta.
- The selected row is a raised sheet with an accent inset.
- "Resolvidas hoje · dá para desfazer" lists items with who decided and "↶ Desfazer". **Never strikethrough.** When
  empty, it teaches: "Nada resolvido hoje ainda. O que você decidir aparece aqui, com Desfazer."

**Detail (structure item, `#inbox`):**
- the risk line ("Alto · estrutura · proposta do Jardineiro, ontem 23:30");
- the title (display 24 serif) and its subtitle;
- the reason in serif reading prose.

**Lens icicle diff** (rows, IcicleDiff):
- "Antes" and "Depois" labels sit above their lanes.
- Cells are positioned by cumulative share, so the children in the after-row align under their positions in the
  before-row.
- New cells are `--surface-selected` with a 1.5 px accent outline and the word **novo**.
- A leaving cell is hatched (`--border-strong`) with a dashed outline. Its callout is right-aligned under it and names
  it: "Horários das refeições sai ↑".
- The direct-notes cell has a dashed outline and is named "notas diretas em Nutrição".
- **Labels never show a bare number.** The order is name + count, then name, then a letter key ("a", "b", …) in a
  circle. Under the lanes, a legend lists each key: "ⓐ Alimentos fermentados · 6 notas", "ⓒ Horários das refeições
  · 3 notas (sai)", "ⓓ notas diretas em Nutrição · 5 notas". Each keyed cell has the full accessible name.
- The shape legend reads: "tópico novo · sai: as 3 notas de Horários das refeições vão para Refeições e cultura ·
  notas diretas em Nutrição, sem subtópico · sem mudança · Ver como lista".

**Impact numbers** (the number style of §4.3) with captions: "85 notas com caminho novo · 3 notas trocam de tópico · 5 ficam
direto em Nutrição · 0 conexões perdidas · 7 → 3 subtópicos diretos (o limite é 6)".

**"O que muda" table:**

| Column | Content |
| --- | --- |
| Tópico | name with a tag (novo / sai) |
| Notas | count |
| Exemplo e o caminho novo | note → new path |
| Nome escrito por | IA local or you |

**Detail (relation item, `#inbox-relation`):**
- The risk line: "Médio · conexão · Jardineiro sugeriu, ontem 23:40 · confiança média (64%)".
- The title: "Duas notas se contradizem sobre gordura saturada".
- The reason: "Nada é apagado em nenhum dos casos: só a conexão muda."
- Two note cards (title, path, quote, source and page), with "contradiz" and its glyph between them.
- "Se você mantiver: …"
- Three verbs, each with a line saying what it stores. None is filled, because a verdict has no safe default:
  - **Manter A:** "A conexão “contradiz” fica e conta como decisão sua."
  - **Remover ⌫:** "A conexão sai, e o Jardineiro não volta a sugeri-la."
  - **Dispensar X:** "Sai da caixa sem decidir; a conexão fica como sugestão nas duas notas."

**Sticky action bar (structure item):** "Aplicar A" (primary), "Dispensar X", "Editar nomes antes E", and "Nada muda
até você aplicar. Depois, dá para desfazer por 30 dias no histórico de Nutrição." The note drops at compact width.

**Key bar** (40): "↑↓ J K navegar · ↵ abrir · A aceitar · ⌫ remover · X dispensar · E editar · U desfazer · ?
atalhos". At the right it reads "Atalhos de uma tecla não funcionam dentro de campos de texto." (dropped at compact
width).

**Key meanings are the same everywhere** (amendment A8 to F4 D29's keys):
- A = accept the proposal (Aplicar a structure change, Manter a relation).
- ⌫ = Remover.
- X = Dispensar only (it leaves the inbox and nothing changes).
- U = Desfazer.

**Undo:** the status-slot toast plus the in-place "Resolvidas hoje" entry (§5.2).

**States:**
- **Empty:** "Nada precisa de você. O Jardineiro pergunta aqui quando uma mudança é arriscada." and "Ver resolvidas".
- **Loading:** a skeleton list and detail.
- **Error** on act: "Não deu para aplicar. Nada mudou." with "Tentar de novo".

**Default (open question §19):** proposals stay unapplied until the person decides.

### 7.5 Mapa (`#map`, `#map-graph`)

**Header:** "Mapa", the tabs "Árvore | Grafo" (D20's Shape and D19's Relations; the ids stay `shape` and
`relations`), the description "Tamanho e saúde da árvore: 412 notas em 38 tópicos",
and "Gráfico e tabela | Só tabela". There is no period control: time appears only as the "7 dias" column and the
inspector line.

**Zoom-out band** (`--surface-selected`): "Você está vendo a árvore inteira. **Esc** volta para Fermentação lática,
onde você estava (dentro de Fermentação, marcada como **aqui**)." with "Voltar Esc". The band is shown only when the
user came from an object.

**Árvore chart:**
- An icicle with **depth left → right** (Áreas | Tópicos | Subtópicos). Height is proportional to notes, and the
  column widths are 25% / 37.5% / 37.5%, so deeper labels get more room. This transposes `buildIcicle`, so labels are
  horizontal and fit.
- Children are sorted by size, largest first.
- Runs of cells shorter than 18 px merge into one dashed cell "mais N · X notas"; a single small cell keeps "name
  count". Merged cells are at least 16 tall. The table keeps every row.
- A cell shorter than 14 px carries no label. Its name is in the tooltip and is announced on arrow focus.
- The selected node has a 2 px accent outline and the selected fill.
- A node over the limit carries the solid warning triangle.
- The ancestor that contains the origin has a 3 px accent inset and "aqui ↳". The legend reads "aqui = contém onde
  você estava".
- Arrows move between cells, ↵ zooms in, and Esc zooms out, then leaves the Map.

**Inspector column:**
- **Selecionado:** "Nutrição · 96 notas · 7 subtópicos diretos (o limite é 6) · +2 notas em 7 dias".
- **O que pesa:** "Passou do limite ontem, quando o Jardineiro criou Alimentos fermentados. Mistura dois assuntos que
  quase não se citam…".
- **Próximo passo:** "Ver a proposta de divisão na Caixa de entrada →".
- **"Mesmos números em tabela":** Tópico (caption size, indented 20/28/36/44, truncated with the full name in the row
  tooltip), Notas, Tamanho ("✓ equilibrado" / "▲ grande demais") and "7 dias". Column widths are 52 / 124 / 64. The
  table is synced with the chart: the selected row equals the selected cell, and the aqui row is marked "· aqui ↳".

**Below the chart:** "A forma nesta semana", a thread with Revisar or Desfazer.

**Grafo tab (`#map-graph`):**
- A branch-scoped graph ("Ramo: Fermentação ▾"). Node dots use `--graph-topic-*`. Edges use the stance colour with the
  stance glyph at the midpoint. Topics outside the branch appear as labelled pills.
- Labels are horizontal, up to two lines, on a halo.
- The legend pairs each topic colour with its name, and each line with its stance glyph and word. It adds "espessura
  = número de conexões".
- "Mesmas conexões em tabela" (De | Conexão glyph + word | Para | Nº) wraps instead of truncating. Its selected row
  equals the highlighted edge.
- A chart without its table is a defect.

**States:**
- **Loading:** a skeleton column.
- **Empty:** "O mapa aparece quando houver tópicos."
- **Error:** with retry.

### 7.6 Ajustes (`#settings`)

**Section column:**
- The title "Ajustes".
- The search field "Buscar: tema, orçamento…" (⌘F), with the help line "Acha também por sinônimo: “escuro” leva a
  Tema."
- Seven sections, each with an icon, a name and a one-line description:
  1. Geral e aparência
  2. IA
  3. Conhecimento
  4. Biblioteca e armazenamento
  5. Integrações
  6. Privacidade e dados
  7. Avançado e diagnóstico
- A section with changed settings shows a dot and its count.
- The foot reads "Cada ajuste mostra se foi alterado e como voltar ao padrão."

**Content:**
- The section title (display 24) and "1 ajuste alterado nesta seção · Restaurar todos".
- Groups (13, 550), then rows. Each row has a label (14, 500), plain-language help (13 secondary), and the control
  at the right: select, segmented control or switch.
- A changed row has a 2 px accent inset, the "• Alterado" marker, and "Padrão: Igual ao da fonte · ↺ Restaurar
  padrão". In the mockup the changed row is "Idioma das notas: Sempre português".
- **Geral e aparência** holds:
  - Idioma do app;
  - Idioma das notas;
  - Tema (Sistema / Claro / Escuro). Its help reads "“Sistema” acompanha o macOS ao longo do dia. Também dá para trocar
    pelo ⌘K: “> tema”.".
- The mockup also shows Densidade, Abrir em and Reduzir animações rows. They are **not settings in F5**: D17's
  registry holds today's settings, and the Settings v2 proposal (T107) leaves them out. Density lives in the Library
  header (§7.3), the Home rule is fixed (D9), and motion follows macOS (§4.7).
- The rows of each section come from the registry v2 (T159) and the Settings v2 proposal. This record binds the frame
  only.
- There is **no reading-size setting**: the scale is fixed (§4.3).

**Search:**
- It matches labels, help text and synonyms ("escuro" → Tema).
- Results are grouped by section and highlight the match with underline and weight.
- Every setting is reachable in ≤ 2 clicks from the rail.
- With no result: "Nada com “x” nos ajustes."

**AI section:** presets come first (plan F5). A later agent details every section. This frame is binding: ≤ 7
sections, search, the changed marker plus reset, and help on every row.

### 7.7 First run (`#empty`, `#first-import`, `#empty-explore`, `#drop`)

**`#empty`** (Home, step 3 of the existing onboarding):
- The step line "✓ Idiomas · ✓ Modo de IA: Híbrido · ③ Primeira fonte".
- The headline "Pronto para a primeira fonte".
- The lead: "Um PDF, um artigo, um vídeo ou uma nota sua. Em poucos minutos ela vira notas curtas, cada uma com lugar
  numa árvore de tópicos que se organiza sozinha."
- The **drop zone** (dashed strong outline, raised):
  - "Solte arquivos aqui, ou escolha como começar";
  - **Escolher arquivo** (primary), Colar link and Escrever uma nota;
  - the formats and "Depois, ⌘N faz o mesmo de qualquer tela".
- **Como importar:** a segmented control with Segundo cérebro / Pesquisável e organizado / Só guardar. The default
  follows the plan rule (§5.2), and the help says why: "Escolhido porque o Híbrido já tem um modelo pronto para
  escrever. Pesquisável e organizado não escreve notas; Só guardar não usa IA."
- "Depois de escolher, você vai direto para a fonte em Explorar e vê as notas chegando."
- "Prefere ver antes? **Abrir a biblioteca de exemplo** (12 fontes sobre fermentação, cidades e música). Dá para
  apagar tudo depois com um clique."
- **"O que acontece depois"** is a thread with hollow nodes: lida e dividida em trechos → vira notas curtas, uma
  ideia por nota → cada nota ganha lugar na árvore → **o Jardineiro**, o trabalho em segundo plano do Memora, arruma
  a árvore e as conexões, sempre com Desfazer.
- **"Combinado":**
  - "Os arquivos ficam no seu Mac. No Híbrido, só trechos vão para a nuvem, e só quando a tarefa pede."
  - "Tudo se desfaz."
  - "Sem configurar nada."
- The pill reads "Tudo em dia" and the Entrada badge is hidden.

**`#first-import`** (the landing after the picker's "Abrir"):
- The app is in Explore, and the new Source is the top panel.
- The tree shows "Fermentação · novo", with the source as a tentative leaf.
- The ribbon reads "Lugar provável: Fermentação · definido quando as notas terminarem".
- The banner reads "Sua primeira fonte está virando notas. Pode continuar usando o app enquanto isso."
- The strip shows "Notas 3 de ~22" and "Na árvore 2 colocadas".
- The newest note has "Procurando lugar na árvore…", and the others have full paths and "tópico novo".
- The context opens on Perguntar.
- The pill reads "Gerando 1 fonte".

**`#empty-explore`:**
- The navigator shows the empty box (§5.3) and "Fixe o que você abre sempre: ⌘D no painel aberto".
- The stack reads "Nada aberto ainda", followed by: "Tudo o que você abrir aparece aqui, um painel ao lado do outro.
  Os mais antigos ficam recolhidos em tiras à esquerda, com o tipo e o título à vista; um clique reabre. Assim o
  caminho até aqui nunca se perde."
- The keys are listed: ↵ abre ao lado · Espaço espia sem abrir · ⌘W fecha o painel em foco.
- Two actions: "Adicionar a primeira fonte" (primary) and "Abrir a biblioteca de exemplo" (the same wording as
  `#empty`).
- The context panel previews itself with the six-stance legend, relacionada included.

**`#drop`** (files dragged over any screen):
- A dashed accent frame around the window and a centred card: "Solte para adicionar 2 arquivos", the file names, and
  "Modo **Segundo cérebro**: notas curtas, lugar na árvore e conexões. Mude no menu de Adicionar."
- "Depois de soltar, você vai para a primeira fonte em Explorar e vê as notas chegando."

## 8. Panel-stack rules

Each destination (Início, Explorar, Biblioteca, Caixa de entrada, Mapa) has its own stack: a root surface plus
panels (D8). Ajustes is a full surface with no stack.

1. **A click opens beside.**
   - Activating an object anywhere in panel P, or in the root surface, opens it as a new panel immediately to the
     right of P. This covers a row, a link, a chip and a ribbon crumb.
   - The panels that were to the right of P go to the closed list (at most 20; ⌘⇧T reopens the last one), so the stack
     is a trail, not a pile.
   - An address that is already open is focused instead of being opened twice.
2. **One top panel.** The newest or focused panel is the top:
   - it is raised with `--shadow-sheet`;
   - it takes the remaining width (at least `--top-min`, §3);
   - it holds keyboard focus;
   - it alone shows the history arrows, Foco and the pin.
3. **The previous panel stays useful.** When there is room (§3), the panel left of the top shows its compact form
   (§6.1), with the row that opened the top highlighted (`aria-current`). That is how you got here.
   - A root surface has a compact form too: Biblioteca shows its title list, the Caixa de entrada its item list,
     Início its section titles and the Mapa its table.
4. **Older panels become spines** (§5.5).
   - More than 6 spines merge into a "+N" spine that opens a list of the hidden panels.
   - A stack holds at most 8 panels *(cal.)*. A 9th evicts into the closed list the leftmost panel that is neither
     focused nor the root.
5. **Returning:** clicking a spine or the previous panel makes it the top. The panels that were to its right stay as
   spines on the right (the forward trail, shown in `#topic`) until the next "open beside" moves them to the closed
   list. Nothing is closed silently.
6. **Per-panel history:**
   - "Abrir neste painel" (⌥-click, or ⌥↵ on a focused row or result) replaces the content of the focused panel and
     pushes onto that panel's history, truncating its forward entries.
   - ‹ › and ⌘[ / ⌘] walk the history. At the start of a panel's history, ⌘[ closes the panel and ⌘] right after
     reopens it (D8). ‹ is shown only when there is history to go back to.
   - The mouse back and forward buttons and the trackpad swipe act as ⌘[ / ⌘] on the focused panel.
   - ⌃⇥ / ⌃⇧⇥ move focus to the next or previous panel.
   - There is **no global back** in the top bar.
7. **Close:** ⌘W or × closes the focused panel into the closed list, and focus moves to its left neighbour. Closing the
   last panel shows the root surface. Explore's root reads "Nada aberto ainda" in an empty library and shows the areas
   overview otherwise.
8. **No click in a panel changes the destination.**
   - Opening an object from Início, Biblioteca, Caixa de entrada or Mapa pushes it onto that destination's own stack,
     beside its root.
   - Cmd-K pushes right of the focused panel of the current destination; from Ajustes it pushes onto Explore's stack.
   - Only these change the destination: the rail, ⌘1-⌘5 and ⌘,; Retomar on Início (Explore's saved stack); Adicionar
     and the first-run file choice (Explore, amendments A6 and A7).
   - Space or ⌘Y peeks without opening.
   - The verb is "abrir ao lado" everywhere.
9. **Layout never depends on kind.** Focus mode (⌘⇧F or "Foco") is the only command that hides the navigator and
   context, and every kind has it. It shows "Modo foco · Esc sai", and Esc or the indicator exits.
10. **Persistence:** per device, in `localStorage` `memora.workspace.v1`, Zod-validated inside try/catch (D8). It holds:
    - each destination's stack (addresses with per-panel history, widths and scroll per panel);
    - the context tab per kind, the hoist, the navigator and context toggles and the density;
    - `lastHomeDay` and `lastHomeOpenAt`.

    The app reopens the last place, except on first run and the first open of each local day, which show Início with
    "Retomar" (D9).

## 9. Path ribbon

- **Where:** above the title on every object page, every kind, every width. It is the `nav` landmark "Lugar na
  árvore". It sticks to the top of the panel body when scrolled (raised background and a hairline).
- **Anatomy:** the topic glyph, then crumbs from root to leaf separated by "›" (tertiary, `aria-hidden`). Each crumb is
  a link that opens that topic beside. The leaf is primary semibold. For a Topic page the crumbs are its ancestors, all
  regular.
- **Secondary places:** a second line in tertiary caption: "também em <link Nutrição › Alimentos fermentados>". With
  more than one, use "também em … e mais 2".
- **Length:** wrap to at most 2 lines. If the ribbon is longer, the middle crumbs collapse into a "…" button that
  expands in place (keyboard reachable). The root and the leaf are never truncated. Compact panels use 12 px.
- **A trailing clause wraps whole.** When it starts a new line, its "·" separator is dropped, so no line starts with
  a separator.

**States:**

| State | Ribbon |
| --- | --- |
| Placed | solid crumbs |
| Tentative (source) | "Lugar provável: <dashed-underlined path> · definido quando as notas terminarem" |
| Question while streaming | "Lugar provável: <dashed path> · pelas citações, quando a resposta terminar" |
| Question done | "<path> · colocada pelas citações" |
| Unsorted | "Sem lugar · Escolher lugar" |
| Loading | a 160×12 skeleton |
| Error | "Não foi possível ler o lugar · Tentar de novo" |

The tree (§5.3) and the Library ("provável:" with a dashed underline) show the same state. A tentative place is
never drawn as placed anywhere.

## 10. Hover preview, quick-look, citation chips

### 10.1 Hover preview and Evidence card

**Trigger:** pointer hover for 300 ms, or keyboard focus held for 300 ms, on object rows, links, tree rows and
relation rows. The card stays while the pointer is on it. Esc dismisses it, and it never traps focus. These rules
meet WCAG 1.4.13.

**Placement and collision:**
- The card goes in free space beside the anchor: the note margin, or the side away from the reading column.
- It is never placed over the anchor row or over the text the anchor belongs to.
- It aligns to the top of the anchor. If it would cross the bottom of the viewport, it shifts up until it fits. If
  that would cover the anchor, it flips to end at the anchor's bottom instead.
- Its height is capped at `100vh − 120` and it scrolls inside.
- **Relation rows in the context panel show no card.** The row's path line already says where it goes, and Space
  peeks. The panel sits at the window edge, and the only free space would be over the note.
- When there is no free side anywhere, there is no card.

**Object card:** kind, title, path, the first 2 lines and counts.

**Relation row card** (the plan's Evidence card, `#note-rel`):
- the stance glyph and word, then the decider and confidence ("Jardineiro decidiu · confiança alta (91%)");
- the direction **in words** ("No séc. XIX, sal e acidez conservavam alimentos sem gelo apoia esta nota");
- **"Vai para <path>"** in a soft box;
- **both passages:** "Trecho de lá" (the other note's evidence) and "Trecho daqui" (this note's), in italic serif;
- "Explicação escrita pela IA local · ontem, 23:14";
- the keys "↵ abrir ao lado · Espaço espiar".

Relation rows always show the target path in the row itself, so the destination is known even without hovering.

### 10.2 Quick-look (peek)

- **Trigger:** Space on any focused row or result outside text fields, or ⌘Y anywhere, including inside Cmd-K
  (amendment A4).
- **Sheet:** a centred sheet, 640 wide. It is **not modal** (`rules/frontend.md`: previews never trap focus and never
  answer ⌘W). The keyboard stays on the underlying row, and a click outside closes it.
  - The head reads "Espiando · Espaço fecha · ↵ abre ao lado" with "↑↓ espiar a próxima" and "⌥↵ abrir neste
    painel".
  - The body shows the kind and format, the ribbon, the title, a serif summary, counts and the first 3 notes.
  - The foot reads "Esc fechar" and says what stays: "A Biblioteca continua aqui; nada foi aberto."
- **Behaviour:** ↑ and ↓ move the underlying selection and update the sheet. Focus returns to the row on close. It
  never stacks a panel.

### 10.3 Citation chips

**Chip:** inline and 20 tall, holding the kind glyph (12) and the number, on soft with a subtle border. Chips are
numbered in reading order, and the numbers match the sources list. A chip attaches to the preceding word with a
no-break thin space, and punctuation follows the chip directly ("perto de 4 [1]; nessa", "multiplicar [2].").

**On hover or focus:**
- The chip turns accent.
- The **matching entry in the sources list expands in place**: a raised sheet with an accent left rule holding the
  passage (italic serif), the cited sentence in `<mark>`, and "Abrir o trecho ao lado ↵".
- The sources list is the Question's Evidência tab, or a note's margin and Evidência block.
- **No card is drawn over the answer.**

**Click or ↵:** opens `#passage` (§6.4).

**At ≤ 1279** (context is a strip):
- The answer is followed by its sources list inline ("Evidência desta resposta · os números são os das citações"),
  because the Evidência tab is folded into the strip.
- Hovering or focusing a chip fills a passage tray at the foot of the panel: "Citação 1 · Microbiologia dos
  alimentos, cap. 3 · p. 47", the passage with its `<mark>`, and "↵ abrir o trecho ao lado · passe o mouse ou o
  foco em outra citação para ler o trecho dela aqui".
- The tray is at most 128 tall and never covers the answer.

**States:**
- A chip whose source is still being read shows "lendo…" in its list entry.
- A chip whose passage was deleted shows "trecho removido · ver a fonte".

## 11. Cmd-K

**Open:** ⌘K or the omni trigger. It is modal (the scrim covers the whole window), and focus goes to the input. Esc
closes it and returns focus.

**Input row** (56, lead 17): glyph, query, and the Esc keycap.

**Prefix row:**
- "Prefixos:" with the chips "> ações", "? perguntar", "# tópicos" and "@ entidades". The chips are buttons, so Tab
  reaches them.
- At the right: "sem prefixo: tudo". The mockup's "perto de <tópico> primeiro" is not built, because D12's ranking has
  no proximity or recency boost (§20).

Typing a prefix character at the start of the query, or activating a chip, changes the mode. The active chip is
pressed. **Space types a space and Tab moves focus** (input → chips → results → preview).

**Results** (virtualized, `role=listbox`), with groups in this order:
1. **Melhor resultado** (1).
2. **Tópicos / Notas / Fontes e entidades / Perguntas**, at most 3 each. Each group header shows its count and
   "mostrar mais (n)" at the right, which opens the search results panel filtered to that kind.
3. **Fazer**, always last: "Perguntar à biblioteca: “…”" and actions. A row shows a real shortcut when one exists
   ("Ir para o Mapa ⌘5") and otherwise none. Prefix characters are never shown as keycaps.

Each row shows the kind glyph, the title, the path or meta line, and right meta ("Tópico · 32 notas", "aberta ontem",
"entidade"). **Matches are marked wherever they occur**, with underline plus semibold: in the title, the path crumbs
and the snippet ("PDF · trecho: “…a fermentação lática reduz o pH…”"). A row whose match is only in its text shows
the snippet line.

**Ranking** is D12's: quick mode, with RRF (k = 60) over the trigram and FTS arms of every kind. The tiebreak is
deterministic: best arm rank, then kind order (topic, source, note, entity, question), then title.
- Recents and pins show only for an empty or one-character query.
- Chunk passages ("PDF · trecho: …") come from full mode. They appear in the search results panel (⇧↵), not in the
  palette's quick results.

**Preview pane** (288, desk colour): kind, title (lead serif), path, summary, "32 notas · 5 fontes · +11 desde ontem",
and children with counts ("5 notas diretas").

**Keys** (D13):
- ↑↓ choose.
- ↵ opens beside: the result is pushed right of the focused panel of the current destination (onto Explore's stack
  from Ajustes).
- ⌥↵ opens in the focused panel: it replaces the panel's content and enters that panel's history.
- ⇧↵ opens the search results panel (full mode) with the query.
- ⌘Y peeks the selected result. Space types a space here.
- In `?` mode, ↵ creates a Question panel that streams.
- In `>` mode, actions show their shortcut.

**Foot:** "↑↓ escolher · ↵ abrir ao lado · ⌥↵ abrir neste painel · ⇧↵ todos os resultados · ⌘Y espiar" and "18
resultados · 14 ms". The mockup's foot shows ⌘↵; this record binds.

**States:**
- **Empty query:** Recentes (5), Fixados and suggested actions.
- **No result:** "Nada com “x”." with "Perguntar à biblioteca: “x” ↵" and "Adicionar fonte".
- **Slow** (> 150 ms): skeleton rows under the groups already shown.
- **Index rebuilding:** "A busca está se atualizando; por enquanto, só títulos." with "Tentar de novo".
- **Performance:** p95 ≤ 100 ms.

## 12. Keyboard map

Single-key shortcuts (marked ¹) and Space never fire in text fields, contenteditable or dialogs. Every shortcut also
has a visible control. The `?` sheet (`#keys`) lists them by scope.

| Key | Action | Scope |
| --- | --- | --- |
| ⌘K | Cmd-K (prefixes > ? # @ typed at the start) | global |
| ⌘N | Adicionar fonte (file picker); drop files anywhere | global |
| ⌘1 … ⌘5 | Início, Explorar, Biblioteca, Caixa de entrada, Mapa | global (replaces today's ⌘1-⌘8; ⌘6-⌘8 are freed) |
| ⌘, | Ajustes | global |
| F6 / ⇧F6 | cycle regions: rail → top bar (omni, status slot, Adicionar) → navigator → stack → context | global |
| U¹ | undo what just happened (the action shown in the status slot) | global while shown |
| ?¹ | keyboard sheet, grouped by scope | global |
| ⌘[ / ⌘] | back / forward in the focused panel; at the start of its history ⌘[ closes it and ⌘] reopens it (D8) | every stack |
| ⌃⇥ / ⌃⇧⇥ | focus the next / previous panel | every stack |
| ⌘⇧T | reopen the last closed panel | every stack |
| ⌘W | close the focused panel (a dialog first, if one is open; never the window) | app menu |
| ⌘D | pin / unpin the top object in the navigator | every stack |
| ⌘⇧F | focus mode on/off (Esc also exits) | every stack |
| ⌘\ | show or hide this destination's navigator | destinations with a navigator |
| ⌘⇧\ | show or hide the context panel (overlay at ≤ 1279) | every stack |
| ⌥1 … ⌥6 | context tabs Conexões, Evidência, Perguntar, Menções, Grafo, Histórico (never inside a text field or editor) | every stack |
| ↵ | open beside | lists, tree, tables, results |
| ⌥↵ / ⌥-click | open in the focused panel ("abrir neste painel") | panels, Cmd-K |
| ⇧↵ | open the search results panel with the query | Cmd-K |
| Space¹ | peek the focused row | lists, tree, Library, Inbox |
| ⌘Y | peek, including inside Cmd-K | everywhere a row is focused |
| /¹ | focus the filter | navigator, Library |
| ↑ ↓ ← → Home End | tree navigation; → expands, ← collapses | navigator |
| Esc | close peek, card, menu, Cmd-K, drawer or overlay; exit focus mode; leave the Map zoom-out; stop streaming | contextual, innermost first |
| ↑↓ / J K¹ | next / previous item | Caixa de entrada |
| A¹ | accept: Aplicar a structure change, Manter a relation | Caixa de entrada, suggestions |
| ⌫¹ | Remover (a relation) | Caixa de entrada, suggestions |
| X¹ | Dispensar (leaves the inbox; nothing changes) | Caixa de entrada |
| E¹ / R¹ | edit names before applying / try again | Caixa de entrada |
| ⌘F | search in Ajustes | Ajustes |

There are no ⌘. / ⌘E / ⌘I / ⌘P bindings (⌘P stays Print, plan §5). There is no ⌥-Arrow binding either
(`rules/frontend.md`): hoist is a menu command (§5.3).

**Brazilian keyboards (ABNT2) and other layouts:**
- Shortcuts whose character needs Shift, Option or a dead key on some layout are matched by **physical key code**
  (`KeyboardEvent.code`), not by the produced character. This covers ⌘[ ⌘], ⌘\ ⌘⇧\, `/`, `?` and ⌥1-⌥6; on the
  macOS Brazilian layout, ⌥1-⌥6 would otherwise type characters.
- Letter shortcuts (A, X, E, R, U, J, K, D, Y, N, W, F, K) are matched by character.
- The `?` sheet draws each keycap with the label of the user's current layout (from the keyboard layout map). It also
  says: "No teclado brasileiro (ABNT2), atalhos com símbolos seguem a posição da tecla; esta folha mostra as teclas
  do seu teclado."
- **Fallbacks:** every key-code shortcut also has a menu item in the app menu (Ir, Painel, Ver). ⌘⇧[ / ⌘⇧] are
  accepted for ⌘[ / ⌘] where a layout puts brackets behind Option.
- The implementation agent checks ⌘\ and `/` on ABNT2 and US-International before F5 closes.

## 13. Copy in pt-BR

**Tone:**
- Plain, calm and specific: a colleague who reports what happened and what you can do next.
- Use sentences, not labels, for states.
- Numbers always carry their noun.
- Use the second person ("você") without exclamation marks.
- Say what happens next and that it can be undone.
- All copy goes through `@app/i18n` in 5 locales, and keys never contain variable parts.

**Typography rules** (the mockup's `nbsp()` and `mx()`):
- A **no-break space** binds a number to its noun ("2 fontes", "~3 min", "9 mudanças"), a locator to its number
  ("p. 47", "cap. 3", "v. 12", "US$ 1,80") and "7 de ~18".
- **A separator binds to the item that follows it.** Each meta item is an inline-block, and "·" is its `::before`.
  The meta line clips the leading separator of each line, so a line never starts or ends on "·".
- A word joiner follows each hyphen in a file name, so "aula-04.txt" never breaks.
- Use `text-wrap: pretty` on meta and help text and `text-wrap: balance` on titles.
- Write file names, paths and titles exactly as stored; never abbreviate a title ("O ácido lático inibe patógenos ao
  baixar o pH", not "Ácido lático inibe patógenos").

**Examples:**
- "Gerando 1 fonte · 3 em espera · 3 precisam de você"
- "motivo: espera o modelo local ficar livre"
- "Nada muda até você aplicar. Depois, dá para desfazer por 30 dias no histórico de Nutrição."
- "Lugar provável: Planejamento urbano › Mobilidade ativa · definido quando as notas terminarem"
- "Procurando lugar na árvore…"
- "Já dá para perguntar a esta fonte: os trechos estão indexados."
- "Os tópicos nascem sozinhos. Você não precisa criar pastas."
- "Nada foi apagado. Cada mudança tem Desfazer e fica no histórico do objeto."
- "Não deu para ler a página 12 (PDF protegido). Pular página · Tentar de novo"
- "Atalhos de uma tecla não funcionam dentro de campos de texto."

**Actors** (who did what; a reader must always be able to tell them apart):

| Actor | Means | Write |
| --- | --- | --- |
| Jardineiro | the background agent that decides structure and connections | "Jardineiro sugeriu", "Jardineiro decidiu", "proposta do Jardineiro"; never "a IA sugeriu" |
| IA local / IA na nuvem | the model that wrote a text | "Escrita pela IA local", "explicação escrita pela IA na nuvem" |
| você | the person | "você ligou", "revisada por você", "aplicada por você" |
| Memora | the app as a whole | "o que o Memora faz em segundo plano" |

The Jardineiro is introduced once on first run and in the tooltip of every "Jardineiro" mention in the pill and on
Home (§5.2).

**One name per concept:**

| Concept | Name everywhere | Never |
| --- | --- | --- |
| typed relations between notes | Conexões (the tab, the body section, the inbox kind "conexão") | Relações (in UI copy) |
| a canvas of nodes and edges | Grafo (the context tab, Map › Grafo) | Relações as a tab name, Mapa for a graph |
| the tree overview destination | Mapa, with the tabs Árvore and Grafo | Forma |
| passages behind an object or answer | Evidência ("Evidência desta resposta" on a Question) | Fontes da resposta |
| the global background log | Atividade (pill and drawer) | |
| one object's change log | Histórico | Atividade desta nota |
| mentions without a relation | Menções ("onde este objeto é citado sem uma conexão") | |
| a source with no notes on purpose | "Guardada, sem notas"; the filter chip is "Sem notas" | Só armazenadas |
| topic health | "equilibrado" / "grande demais" (and "raso demais", reserved); the column is "Tamanho" | boa, atenção, fora do limite |
| confidence | "confiança alta" / "confiança média", plus % in cards | 0,91 |
| new since the last visit | "+N" with the legend "+N = novas desde <quando>" | |
| the tree position | lugar ("Lugar na árvore", "Lugar provável", "Sem lugar") | "abrir no lugar" |
| replacing a panel's content | "abrir neste painel" | |

**Glossary** (use exactly):
- **Destinations:** Início, Explorar, Biblioteca, Caixa de entrada (rail: Entrada), Mapa, Ajustes.
- **Object kinds:** Fonte, Nota, Tópico, Pergunta, Entidade.
- **Places and features:** Jardineiro, Sem lugar, Fixados, Recentes, Atividade, Histórico, Para relembrar.
- **Context tabs:** Conexões, Evidência, Perguntar, Menções, Grafo, Histórico.
- **Stances:** apoia, contradiz, estende, depende de, é exemplo de, relacionada (the existing `notePage.stance.*`).
- **Activity sections:** Agora, Em espera, Precisa de você, Desde a sua última visita, Orçamento.
- **Import modes:** Segundo cérebro, Pesquisável e organizado, Só guardar.
- **Verbs:** abrir ao lado, abrir neste painel, espiar, fixar, desfazer, aplicar, aceitar,
  dispensar, manter, remover, retomar, pausar, tentar de novo, restaurar padrão, gerar notas.

**Words to avoid, and what to say instead:**

| Avoid | Say instead |
| --- | --- |
| mesa, lombada | (no metaphor in controls; "tiras à esquerda" when explaining spines) |
| job, tarefa, fila de processamento | Atividade, trabalho em segundo plano |
| pipeline, chunk | trecho |
| embedding, rerank, score | confiança (alta / média) |
| cluster, node, UUID | (the object's name) |
| Wiki, Grafo do Conhecimento (as a destination), Monitoramento, Revisar notas | (the current destination names) |
| Configurações | Ajustes (also fixes today's unaccented "Configuracoes") |
| deletar | apagar, remover |
| "Clique aqui" | (name the action) |
| "Tem certeza?" | (offer Desfazer instead) |
| "Erro" or "Falhou" alone | (say what failed, what is kept and the next step) |
| insights, dashboard, match | (plain Portuguese) |
| "Processando…" or "Jardineiro ativo" with no object or step | (name the object and the step) |
| J K mover | ↑↓ J K navegar |
| Exclamation marks | (none) |
| Unaccented Portuguese | (accented Portuguese) |

## 14. Do and do not

| Do | Do not |
| --- | --- |
| Put the path above every object title, zero clicks | Make location a hover, a click or a separate page |
| Show one truth about place (tentative in tree, ribbon and Library alike) | Draw a tentative source as placed |
| Write states as sentences with a reason ("motivo: …") | Show a bare spinner, a bare count or a colour dot |
| Keep one filled button per screen (Retomar, Aplicar, Escolher arquivo) | Fill Adicionar, Manter, every CTA |
| Show undo in the status slot, in place and on the object's Histórico | Float a toast over action bars or table rows |
| Use stance glyph + word in the stance colour, direction "origem verbo destino" | Use colour alone, arrows like "← chega / → sai", or reverse a relation |
| Expand a cited passage in the sources list or the passage tray | Draw a card over the answer it supports |
| Stack on click; spines read top-to-bottom with the kind first | Switch the destination from inside a panel, or rotate text bottom-to-top |
| Wrap the ribbon to 2 lines, then collapse middle crumbs | Truncate the leaf ("Fermentação lá…") in a ribbon |
| Cut tree and list names only at word boundaries, keeping the distinguishing end ("…alcoólica"); wrap the open row | Cut inside a word ("Fermentaç…alcoólica") or cut siblings to the same stub ("Ferment…") |
| Label icicle cells name + count → name → letter key with a legend | Show a bare number or a stub like "Ecol…" |
| Mark search matches with underline + weight, also in paths and snippets; `<mark>` = selected tint | Use warning yellow as a highlight |
| Mark selection with the accent bar or inset plus the tint | Show selection by tint alone |
| Keep proposals unapplied until the person decides | Apply a high-risk structure change and ask afterwards |
| Use outline tags, outline kind/stance glyphs and solid state glyphs with words | Use filled state pills or coloured badge tiles per row |
| Put words on the rail and the context tabs | Rely on icon tooltips for navigation |
| Give every icon-only control a tooltip and an accessible name | Ship an icon whose meaning has to be guessed |
| Show skeletons for loading, dashed outlines for empty | Draw grey bars anywhere that is not loading |
| Use serif for reading, Inter for operating, the fixed scale only | Use 10 / 11 / 32 px or opacity-dimmed text |
| Toggle focus mode explicitly with a visible exit, on every kind | Hide the tree because the object is a note |
| Pair every chart with its table, synced with the selection | Ship a canvas whose "table" shows different numbers |
| Bind numbers to nouns and separators to the next item | Leave "2 / fontes" or a line that starts with "·" |

## 15. Journeys and step counts

Clicks or keys, excluding typing. The OS file picker's "Abrir" counts as a click.

| # | Journey | Path | Steps |
| --- | --- | --- | --- |
| 1 | First run to notes with paths | `#empty` Escolher arquivo (1) → picker Abrir (2) → `#first-import`: notes arrive with paths, no further click | **2** |
| 2 | Import in a populated app | Adicionar (1) → picker Abrir (2) → the Source on top of the Explore stack | **2** (drop: 1) |
| 3 | Read a topic | ⌘K "#ferm" ↵ (1); or Fixados (1); or the tree, up to 4 if collapsed | 1-4 |
| 4 | Follow a relation | a Conexões row with its path (1) | **1** |
| 5 | Triage the Inbox | Entrada (1) → A / ⌫ / X (2); U undoes | **2** |
| 6 | Ask and jump to a citation | ⌘K (1) → "? pergunta" ↵ (2) → hover a chip to read the passage (0) → click (3) → `#passage`, "Voltar à resposta ⌘[" | **3** |
| 7 | Find where a note lives | open it: the ribbon and the tree show it | **0** |

## 16. Per-screen acceptance checklist

A reviewer ticks these against screenshots of the real app in light and in dark. Gate U captures at 960 and 1440 px
(D1):
- items marked "at 1000×700" are checked at 960 (the compact tier);
- the other items are checked at 1440;
- a reviewer may ask for a 1280 capture.

The mockup's own shots are at 1000, 1280, 1440 and 1680.

**All screens**
- [ ] The rail shows 5 worded destinations and Ajustes, with no theme toggle; the active one has the accent bar.
- [ ] The top bar shows the destination name, the omni trigger with ⌘K at the same x on every screen, the status
      slot in words, and Adicionar as an outlined split button with a chevron.
- [ ] At most one filled button is visible.
- [ ] No text is below `--text-tertiary`, and no size is outside 12/13/14/16/17/20/24.
- [ ] Colour appears only on kind glyphs, stance glyph+word and state glyph+word (plus the Map › Grafo topic dots).
- [ ] **No state is shown by tint alone**: every selected or current row has the accent bar or inset.
- [ ] Accent text is a link, a focus or selection mark, or "new since your last visit".
- [ ] No number is split from its noun, and no line starts or ends with "·".
- [ ] No horizontal scroll at 960 wide.
- [ ] Dark is as finished as light: sheets are lighter than the desk, no element keeps a light-theme colour, and the
      graph has no dark island in light.
- [ ] Every loading state is a skeleton; every empty state teaches the next action; every error has "Tentar de novo".
- [ ] The same record shows the same title, actor and time on every screen (fixture check).
- [ ] Every icon-only control has a tooltip and an accessible name. No tree or list label is cut inside a word, and
      a cut label shows its full title on hover and on focus.

**#home**
- [ ] Date line, serif greeting, briefing whose clauses match the data (§7.1), and the reassurance line.
- [ ] Retomar card with the trail (kind + serif title, no grey bars) and "Retomar ↵" as the only primary button.
- [ ] The Shape strip with "1 tópico grande demais · Ver no Mapa".
- [ ] Precisa de você (Bloqueada first), O que o Jardineiro fez (thread with the exact titles and the direction
      "origem apoia destino", Desfazer per row), Chegou (paths, progress) and Perguntas recentes (F5). All start
      above the fold at 1280×800, and all column headers use one pattern.
- [ ] The pill has no needs-you clause on Home.
- [ ] At 1000×700, two columns with no clipped text.

**#explore**
- [ ] The navigator shows Fixados, Árvore with counts and the +N legend, +N on collapsed rows, a solid warning
      triangle on Nutrição, Recentes, and "Sem lugar · 3 notas · 2 fontes".
- [ ] The open note is highlighted with the accent bar, and its ancestors are semibold and uncut.
- [ ] The stack shows spines (glyph, then kind and title top-to-bottom) and the top note on a raised sheet with Foco.
- [ ] One paragraph of the top note has 60-70 characters per line.
- [ ] The top note shows the ribbon (full path plus "também em"), a serif title with no orphan, meta, prose with
      numerals, Evidência, and the Conexões summary chips.
- [ ] The context panel shows one row of tabs (Conexões, Evidência, Perguntar, Mais) with an underline on the
      selected tab, aligned with the 40 px panel headers. Conexões is grouped by stance with directional phrases,
      each row has a path line, and there is a dashed suggestion with Manter A / Remover ⌫ and "decida quando
      quiser".
- [ ] At 1000×700: the context is the worded strip, the top panel is ≥ 568, the parent topic is readable in full and
      the open row shows two lines, siblings are distinguishable and cut only at word boundaries ("…alcoólica"), and the body shows the full
      Conexões list.
- [ ] `#explore-ctx` at 1000×700: the overlay opens over the top panel's right edge with the strip pressed.
- [ ] At 1680×1000: the previous panel is visible as a compact list with the current row marked.
- [ ] `#explore-focus`: focus rings are visible on a tree row (inset), a context row (inset) and Foco (outside).

**#note / #note-rel** (focus)
- [ ] "Modo foco · Esc sai" is visible; the navigator and context are hidden; the previous panels are spines.
- [ ] A 600 text column with a display 24 title. The margin holds Evidência (numbered, italic serif, `<mark>`).
      Paragraph spacing is even.
- [ ] Conexões rows show the stance glyph + directional phrase, the target path, who decided with confidence in
      words, and who wrote the explanation. The suggestion row has Manter A / Remover ⌫.
- [ ] The Evidence card sits in the margin, not over the rows, fits in the viewport, and shows "Vai para <path>",
      "Trecho de lá" and "Trecho daqui".
- [ ] Histórico is a thread with Desfazer. "Lugar na árvore", Entidades and "Endereço" are in the margin.

**#source / #first-import**
- [ ] The ribbon shows "Lugar provável:" with a dashed path and "definido quando as notas terminarem". The tree shows
      the source as a tentative leaf with "provável", and the Library row agrees.
- [ ] The generation strip shows the running ring, the time left, the model and cost, "Já dá para perguntar",
      Pausar, six steps with values in primary text, and the section ruler with its caption and names.
- [ ] The teaching hint sits above the notes.
- [ ] Notes are newest first, each with a **full path**. The newest has a new-dot and "agora mesmo" (no fill).
      There is one "tópico novo" tag, one "Procurando lugar na árvore…" and a skeleton row.
- [ ] Foco is on the header. The context is on Perguntar.
- [ ] `#first-import` is reached from `#empty` in 2 clicks and shows notes with paths at once.

**#cmdk**
- [ ] The scrim covers the whole window and the input shows the query.
- [ ] The prefix chips are shown, with "sem prefixo: tudo" at the right.
- [ ] Group order: Melhor resultado → Tópicos → Notas → Fontes e entidades → Fazer last, each with "mostrar mais
      (n)".
- [ ] Matches are underlined and semibold in titles, paths and snippets, never yellow.
- [ ] The preview shows path, summary, counts, "+N desde ontem" and children.
- [ ] The foot shows "⌥↵ abrir neste painel", "⇧↵ todos os resultados" and "⌘Y espiar" (no Space, no Tab), plus "N
      resultados · N ms".

**#ask / #passage**
- [ ] The ribbon shows "Lugar: sai das citações quando a resposta terminar" while streaming and "<path> · colocada
      pelas citações" when done. The status band names the D14 stage.
- [ ] The status band and the follow-up field end at the same right edge as the answer text.
- [ ] Chips carry the kind glyph and number, attach to the preceding word, and one is active.
- [ ] Context Evidência ("Evidência desta resposta"): the matching entry is expanded with the passage and "Abrir o
      trecho ao lado ↵"; one entry is "lendo…"; "Lidas, não citadas" is present.
- [ ] No card covers the answer text.
- [ ] At 1000×700: the inline sources list follows the answer, and the passage tray shows the hovered citation.
- [ ] `#passage`: the source is beside the question with the sentence in `<mark>` and "Voltar à resposta ⌘[".

**#topic / #entity**
- [ ] Topic: full page with "tamanho equilibrado", Subtópicos, Notas, Fontes, Foco, a forward spine on the right,
      and the Grafo tab with the legend and "Abrir no Mapa › Grafo" (no topic ego-graph in F5).
- [ ] Entity: ribbon "mais citada em …", Menções by topic, and context Perguntar.

**#library / #peek**
- [ ] Filter field; state chips with counts (Sem notas); the territory bar adding up to 48 with "Sem lugar 2 fontes";
      the density toggle (no Ajustes row); the Fontes | Perguntas tabs.
- [ ] Rows: glyph + title + format line, path (with "…" and dashed "provável:"), notes, state glyph + word (with the
      reason when needed), date. No badge tiles and no filled pills. The selected row has the accent bar.
- [ ] Sortable headers with `aria-sort` (Adicionada, newest first).
- [ ] Foot: "↵ abrir ao lado · 48 fontes · as mais novas primeiro".
- [ ] At 1000×700: Notas and Adicionada drop, Estado stays, and nothing is clipped.
- [ ] #peek: a centred, non-modal sheet with "Espiando · Espaço fecha · ↵ abre ao lado", "↑↓ espiar a próxima", the
      ribbon, a serif summary and "Esc fechar".

**#inbox / #inbox-relation**
- [ ] List: Bloqueada first, then risk groups; the selected row is a raised sheet with the inset; Resolvidas hoje has
      Desfazer and no strikethrough, or the teaching empty line.
- [ ] Detail: risk line, serif title with its subtitle, serif reason.
- [ ] Before/after lanes are aligned; `novo` cells are outlined with the word; the leaving cell is hatched and named
      "Horários das refeições sai ↑"; the direct cell is dashed and keyed; **no cell shows a bare number** at 1280 or
      at 1000; the key legend names every keyed cell.
- [ ] Five impact numbers (85 / 3 / 5 / 0 / 7 → 3) and the "O que muda" table with examples and "Nome escrito por".
- [ ] Sticky action bar: Aplicar A (primary), Dispensar X, Editar nomes antes E, and "Nada muda até você aplicar…".
- [ ] Key bar: "↑↓ J K navegar · A aceitar · ⌫ remover · X dispensar …" with the single-key rule.
- [ ] `#inbox-relation`: two note cards with "contradiz", three verbs with helper text and none filled; the pill
      extension reads "Nutrição dividida em … · Desfazer U" and keeps "2 precisam de você"; the applied item is in
      Resolvidas hoje with "agora" and Desfazer.

**#map / #map-graph**
- [ ] Árvore | Grafo tabs, and Gráfico e tabela | Só tabela.
- [ ] Zoom-out band: "Esc volta para <tópico>, onde você estava (dentro de …, marcada como aqui)" and Voltar Esc.
- [ ] Icicle with depth left → right (25 / 37.5 / 37.5), children sorted, small runs merged into "mais N · X notas",
      labels only where they fit, the selected outline, the warning glyph, and "aqui ↳" on the ancestor.
- [ ] Inspector: Selecionado / O que pesa / Próximo passo (a link into the Caixa de entrada).
- [ ] The table is always visible and synced, with Tamanho as glyph + word and a "7 dias" column, and no horizontal
      scroll.
- [ ] Grafo: the canvas reads the theme, labels sit on a halo, the legend names the topic colours and stances, and
      the edge table wraps and matches.

**#activity**
- [ ] The pill is pressed (`aria-expanded`), and the drawer is non-modal on the right.
- [ ] Agora has at most one "modelo local" row. Em espera rows each have "motivo:", including the wait for the local
      model. Precisa de você has the risk and "Abrir ⌘4". "Desde a sua última visita" has Desfazer per row, and the
      import row has "Remover a fonte". Orçamento has bars with numbers and plain text.

**#settings**
- [ ] ≤ 7 sections with descriptions; the search field "Buscar: tema, orçamento…" uncut, with the synonym help line;
      the changed count on the section.
- [ ] Open section: title, "N ajuste alterado nesta seção · Restaurar todos", groups, rows with help text, and one
      row marked "Alterado" with "Padrão: … · Restaurar padrão". Tema is here. There is no reading-size, density,
      "Abrir em" or reduced-motion row.

**#empty / #empty-explore / #drop / #add-menu / #keys / #states**
- [ ] `#empty`: the step line at 3 of 3; the drop zone with three entry modes (only "Escolher arquivo" filled); the
      import-mode segmented control with its reason; "Abrir a biblioteca de exemplo"; the promise thread
      introducing the Jardineiro; the three guarantees; and a pill that reads "Tudo em dia".
- [ ] `#empty-explore`: the navigator box "Os tópicos nascem sozinhos…", "⌘D", the stack teaching "tiras à
      esquerda" and keys with two actions, and a context preview with all six stances.
- [ ] `#drop`: the window frame and a card naming the files, the mode and where you land.
- [ ] `#add-menu`: three entry modes and the "Ao importar" radio group with the recommended mode.
- [ ] `#keys`: grouped by scope, with the ABNT2 note.
- [ ] `#states`: loading, empty and error for the navigator (with hoist), panel, context, Home, Cmd-K, generation and
      the Inbox, plus the "+N" spine list.

## 17. Fixture

Every screen of the mockup renders from one JSON fixture, `FIX`. It sits between the markers `/*@FIX@*/` and
`/*@FIXEND@*/` in `docs/design/f5-workspace/mockup.html`. The screen modules' fake `window.app` fixtures (T138)
copy its values.

| Record | Values |
| --- | --- |
| Tree | 412 notes in 38 topics. Roots: Ciências da vida 128 (+14), Nutrição 96, Planejamento urbano 84 (+6), Teoria musical 70 (+9), História da ciência 34 |
| Nutrição before the split | 5 direct notes; 7 direct subtopics (limit 6): Alimentos fermentados 6, Vitaminas e minerais 24, Fibras 10, Hidratação 6, Dietas 22, Refeições e cultura 20, Horários das refeições 3 |
| Nutrição after the split | Alimentos fermentados 6 stays; Micronutrientes 40 = 24 + 10 + 6; Padrões alimentares 45 = 22 + 20 + 3 (the 3 notes of Horários das refeições go to Refeições e cultura); 85 notes get a new path; 3 change topic; direct subtopics 7 → 3 |
| Arrived since the last visit | Ruas completas (7 notes, 6 placed, generating, hoje 09:12); Ritmo e síncope no choro (9, hoje 06:10); Kefir e kombucha em casa (14, ontem 22:35). Total 30 notes, 29 placed |
| Gardener | 9 changes. Shown: c1 23:10 created Alimentos fermentados in Nutrição and moved 6 notes; c2 23:14 linked "No séc. XIX, sal e acidez conservavam alimentos sem gelo" apoia "O ácido lático inibe patógenos ao baixar o pH"; c3 23:20 renamed "Coisas de cidade" → Urbanismo tático |
| Caixa de entrada | i3 Bloqueada "Escolher o idioma de aula-04.txt"; i1 Alto "Dividir Nutrição em dois tópicos" / "em Micronutrientes e Padrões alimentares", proposed ontem 23:30; i2 Médio "Duas notas se contradizem sobre gordura saturada", ontem 23:40, confiança média (64%) |
| Library | 48 sources, 412 notes. Territory: 13 / 9 / 11 / 8 / 5 / Sem lugar 2 |
| Unsorted | 3 notes · 2 sources |
| Waiting | 3 rows |
| Timeline | t0 = every screen; t1 = `#inbox-relation`, right after the split was applied (badge 2, the toast extension, the split in Resolvidas hoje) |

The design workflow's checker (`.cache/f5/design/final/_work/check-fixture.mjs`, untracked) asserted 26 invariants on
it: the sums above, the counts on each screen, and the canonical strings. The renderer fixtures keep the sums as a
test (§18).

## 18. Build notes

These are for the implementation agents. A dependency beyond D2's four needs the orchestrator's approval.

- **Needed primitives** (T124): on D2's `radix-ui@1.8.1` and `cmdk@1.1.1`, hand-vendored in `R/components/ui/`, with
  no shadcn CLI:
  - Dialog (Cmd-K, keyboard sheet) and a non-modal sheet (Peek);
  - Popover / HoverCard (Evidence card);
  - Command (cmdk) and Tooltip;
  - ScrollArea and Tabs (a one-row priority+ tablist);
  - DropdownMenu (Adicionar, Mais), RadioGroup, and a segmented control (`toggle-group`).
- **Testing:** renderer tests run in node. Keyboard, focus and hover rules (§10, §12) need the Playwright-Electron
  journeys of the F5 exit, including Space typing in Cmd-K and ⌘Y peeking.
- **Virtualize:** the tree (exists), topic note lists (both the previous panel and the top panel), the Library table
  and Cmd-K results.
- **"+N since last visit":** one rolled-up query per tree load, never one query per row. It counts the notes created
  after `lastHomeOpenAt`, which the renderer passes as `since` (D9), aggregated up the tree. `view_history` stays
  object rows only.
- **Layout:** the stack is a CSS container (`container-name: stack`), and the previous panel shows at
  `@container stack (min-width: 848px)`. The layout constants of §4.9 are typed configuration. `layout()` (spec 3.1)
  returns `full`, `compact` (the previous panel) or `spine` per panel, with `--top-min` as its floor (amendment A1).
- **Label fitting** (all measure after fonts load and re-run on resize and theme change):
  - tree: §5.3;
  - Inbox icicle: name + count → name → letter key with a legend; never a bare count;
  - Map icicle: sort, merge runs under 18 px, no label under 14 px;
  - ribbon: drop the trailing "·" on wrap.

  Reuse `icicle-layout.ts` with x and y swapped for the Map (depth left → right). The Inbox keeps the row
  orientation of `IcicleDiff`.
- **Status-slot toast:** extend `ActivityHost` (pill + drawer) with a transient undo state that keeps the needs-you
  clause. Retire the floating `ToastViewport` for undoable actions; plain informational toasts are not needed.
- **Local-model rule:** the Activity view-model shows at most one running row whose route is the local model; any
  other local job is "Em espera" with the reason "espera o modelo local ficar livre".
- **Shortcuts:** match symbol shortcuts by `KeyboardEvent.code` (§12) and draw keycaps from
  `navigator.keyboard.getLayoutMap()` when available.
- **Tokens:**
  - add the tokens of §4.10 (at most 8) and map them in `styles.css` `@theme`;
  - change the dark `--border-strong` to #7a899f and re-run `npm run contrast`;
  - T151 retires the dark-canvas `--graph-*` tokens.
- **Fonts:** already bundled. The mockup embeds the same latin subsets.
- **Fixture:** port `FIX` and its checks (§17) into the renderer test fixtures.
- **Clocks:** no `setInterval` and no polling for relative times or estimates (§5.12, D16).
- **Copy:** every string goes through `@app/i18n` in the five locales, with keys in the card's namespace. The pt-BR
  text here is the pt-BR source.

## 19. Owner questions (defaults taken)

The owner is away during F5 (plan decision 34), so these defaults bind until the owner changes them. At gate D the
orchestrator confirmed items 2, 6, 7 and 9 and added items 10-13. All of them are defaults the owner may change, at
the latest in F7.

1. **Proposed or applied structure changes?** A, C and D propose and B applies, then asks. *Default: high-risk
   structural changes stay proposed and unapplied until decided. Low-risk ones are applied with Desfazer.*
2. **Map › Grafo colour.** Plan §6 says "coloured by topic", while §5 allows colour only for kind, stance and state.
   *Default: topic colours (`--graph-topic-*`) on the graph canvas only, always named in the legend and the edge
   table.*
3. **Adicionar click.** *Default: the main part opens the file picker. The chevron offers "Colar link", "Escrever uma
   nota", "Mais opções de importação…" and the import mode.*
4. **Rail label for Home.** *Default: "Início" (Home), not "Hoje", because it also hosts the first run.*
5. **The `--type-display` 24 cap.** A's 32 px hero was rejected because it is outside the scale. Adding a hero size
   would need the owner's sign-off.
6. **Theme toggle in the rail.** The first-time-user critic read "Sistema" as system status. *Default: removed from
   the rail; Tema is in Ajustes and in Cmd-K ("> tema").*
7. **Reading size.** The fixed scale forbids alternatives. *Default: no reading-size setting. If the owner wants one,
   it would be two steps inside the scale (16 and 17).*
8. **Topic glyph vs warning in dark** (ΔE00 2.1). *Default: separated by form (outline glyph vs solid triangle) and
   position. The alternative is a NEW dark warning value further toward orange, which would then sit close to
   "depende de".*
9. **Suggestion routing threshold.** *Default: medium risk or above goes to the Caixa de entrada: confidence below
   "alta", or "contradiz" (amendment A9). The risk is volume: a large library may route many suggestions, so the
   threshold is typed configuration.*
10. **Abrir em, density and reduced motion as settings.** *Default: none of them is a setting in F5 (§7.6). Density
    is the Library toggle, the Home rule is D9's, and motion follows macOS.*
11. **A question's place.** *Default: read from its citations when the answer is done (§6.4). Questions are not
    tree leaves in F5.*
12. **Para relembrar.** *Default: not in F5, because there is no resurfacing schedule yet. Home's fourth column is
    Perguntas recentes.*
13. **Where the first source lands.** *Default: Explore, with the Source on top (amendment A6).*

## 20. Reconciliation with docs/f5-decisions.md

The rule used:
- Behaviour, data and keys follow `docs/f5-decisions.md` (and the spec's cards). The exception is a design choice
  that is clearly better for the user: then this record proposes an amendment to the decision.
- Visuals, layout, copy and states follow the design.
- `rules/` override both.

The body above already applies the binding choice of every row.

### 20.1 Differences and binding choices

| # | Topic | Decision says | Design says | Binding choice | Amendment |
| --- | --- | --- | --- | --- | --- |
| 1 | Destinations and rail | D8: Home, Explore, Library, Inbox, Map, with Settings in the footer. D6: a legacy overflow in the rail footer until the removals. | Início, Explorar, Biblioteca, Entrada, Mapa and Ajustes; no theme toggle; no legacy item. | Both: the five worded destinations and Ajustes, plus the legacy overflow until T166 (§5.1). Theme lives in Ajustes and Cmd-K; the menu's `toggle-theme` stays. | No |
| 2 | Stack model | D8: each destination has its own root surface and panel stack. Plan §5: no click switches the top-level view. | One Explore stack. Opening from Home, Library, Inbox, Map, the drawer or Cmd-K switches to Explore ("abrir em Explorar"). | D8. The design's layout rules (§3, §8) apply to every stack, and the verb is "abrir ao lado" everywhere. Exceptions: Retomar, Adicionar and the first source open Explore (rows 18 and 19). | No |
| 3 | Push, focus and reopen | D8: panels beyond the clicked one go to a closed list, and Cmd-Shift-T reopens. An already-open address is focused. | Panels to the right are replaced; nothing about reopening or duplicates. | D8 (§8 rules 1 and 7, §12). | No |
| 4 | Replace a panel's content | D8: Option-click replaces. D13: Option-Enter replaces. | ⌘↵ "abrir neste painel". | D8 and D13: ⌥-click and ⌥↵, with the design's words "abrir neste painel". | No |
| 5 | Back at a panel's first page | D8: Back closes the panel, and Forward reopens it. | ⌘[ moves focus to the left panel, and nothing closes. | D8. A close is undone by ⌘] or ⌘⇧T, so the design's choice is not clearly better. ‹ stays hidden at the start (design). | No |
| 6 | Panel widths | D8: panel minimum 420 px *(cal.)*; overflow collapses to 40 px spines. | The top panel keeps at least 568 px (the reading measure plus padding). The previous panel is compact (216-240) when the stack is ≥ 848. Spines are 40, and more than 6 merge into "+N". | Design. A 420 px panel leaves about 45 characters per line; 568 keeps 60-70. At the 960-999 window the floor is 552 (§3). | **A1** |
| 7 | Panel cap | D8: at most 8 panels *(cal.)*; a 9th evicts the leftmost panel that is neither focused nor the root. | More than 6 spines merge into "+N". | Both; they are compatible (§8 rule 4). | No |
| 8 | Context panel breakpoint | D8: overlaid below 1200 px. | A 40 px strip plus a 304 overlay at ≤ 1279. | Design: the reading measure needs the width at 1200-1279. | **A2** |
| 9 | Window minimum and capture widths | Window minimum 960 px (`M/index.ts`). D1: gate U captures at 960 and 1440. | Minimum 960×640. Reference shots at 1000×700 and 1280×800. Tiers: 960-1179, 1180-1279, 1280-1439 and ≥ 1440. | 960 minimum. Gate U at 960 and 1440 (D1), mapped in §16. §3 adds the 960 rules: top panel 552, omni trigger ≥ 240, and the pill never covers the trigger (the mockup's 960 render overlaps them). | No |
| 10 | Panel focus keys | D8 (spec 3.1): Ctrl-Tab and Ctrl-Shift-Tab move panel focus. | F6 cycles regions. | Both (§12). | No |
| 11 | Cmd-K keys | D13: Enter pushes, Option-Enter replaces, Shift-Enter opens the search results panel. | ↵ opens beside (switching to Explore), ⌘↵ opens in this panel, ⌘Y peeks, no Shift-Enter. The foot shows ⌘↵. | D13, plus the design's ⌘Y. Foot: "↵ abrir ao lado · ⌥↵ abrir neste painel · ⇧↵ todos os resultados · ⌘Y espiar" (§11). | No (⌘Y is in A4) |
| 12 | Cmd-K ranking | D12: RRF over the arms with a deterministic tiebreak; no recency or proximity boost. Chunk text is in full mode only. | Ranking by exact title, own recent opens, closeness to the focused branch, then meaning. The bias is stated: "perto de … primeiro". Passage snippets appear in the palette. | D12. The bias line is dropped. Passage snippets appear in the search results panel (⇧↵). | No |
| 13 | Quick-look | D15: Space on a focused row opens a quick-look popover; Esc closes it. | Space outside fields and ⌘Y everywhere, including Cmd-K. A centred 640 sheet, with ↑↓ peeking the next row. Listed as modal. | Design's sheet, ⌘Y and ↑↓, made non-modal (`rules/frontend.md`: previews never trap focus). | **A4** |
| 14 | Hover cards and citation chips | D15: a HoverCard after 300 ms on any object link or citation chip, showing the cited passage. | Object links get the card on hover or focus. A chip expands its passage in the sources list (or a passage tray below 1280), never in a card over the answer. Relation rows in the context panel get no card. | Design: it never covers the text being read, and it meets the plan's "hover shows the passage". | **A3** |
| 15 | Context panel tabs | D31: Connections, Mentions, Evidence, Graph, Activity (the object's change-sets with Undo) and Ask. | Conexões, Evidência and Perguntar are shown; "Mais" holds Menções, Grafo and Histórico. Each kind has a default tab; ⌥1-⌥6 switch tabs. | D31's six tabs and contents, with the design's labels, order and priority+. Histórico is D31's Activity tab. ⌥1-⌥6 never fire in a text field. | **A5** (label) |
| 16 | Graph tab for other kinds | D11: `objects.neighborhood` stays notes-only. T143: other kinds link to Map › Relations. | `#topic` shows a topic ego-graph. | D11 and T143 (§5.6). | No |
| 17 | Ask tab scope | D31: Ask is scoped to the focused object. D14: the scopes are library, topic and source. | Perguntar is scoped to the top object of any kind. | D14's scopes, mapped per kind (§5.6): a note asks its primary topic; an entity or a question asks the library. The scope is always written. | No |
| 18 | Home rule and first source | D9: Home on first run and on the first open of each local day, otherwise the last place. After onboarding, Home opens with the first source's panel pushed. | The same rule, plus an "Abrir em" setting with three options. The first file lands in Explore with the Source on top and the tree being born. | D9's rule, with no setting (row 25). The first source opens in Explore (design): it teaches the tree and the path at the moment they appear, and X1's count is unchanged. | **A6** |
| 19 | Add flow | D32: the advanced import panel is reached from the "Add sheet". T150: a quick sheet, then confirm, then a toast with "Open". | A split button: the main part opens the file picker, and the chevron menu offers a link, a note and the import mode. The Source is pushed at once; a drop imports at once. No floating toast. | Design, plus "Mais opções de importação…" in the menu for D32's panel. One gesture fewer and no toast over content. | **A7** |
| 20 | Ask stages and staleness | D14: retrieving, answering, waitingForProvider, done, failed and canceled; staleness computed on read; "Ask again" makes a new version. | A streaming band, a done band, stopped, route error and no grounding. No waiting-for-provider state, no stale state. | D14, with copy for every stage and for staleness (§6.4). "Refazer" is "Ask again". | No |
| 21 | A question's place | D11: `locate` for all five kinds. Spec 3.3: a question's place is its scope topic's chain, or the library root. | "Lugar provável … pelas citações" while streaming and "colocada pelas citações" when done; the question is a tentative tree leaf. | Read from the citations when done; no path while streaming; not a tree leaf (§6.4). A library root path tells the user nothing. This is a spec change (§20.3 S4), not a decision change. | No (spec) |
| 22 | Inbox keys | F4 D29: j/k, Enter, a, x (dismiss **or remove**), r, u and ?. | A accepts, ⌫ removes, X only dismisses, E edits names, R retries, U undoes; J/K and ↑↓ move. | Design. Removing (the Jardineiro never suggests it again) and dismissing (nothing changes) are different verdicts. The first-time-user critic flagged the merged key as a must-fix. | **A8** |
| 23 | Inbox routing | F4 D29's Inbox kinds include `contradiction` (a suggested "contradicts") but no other suggestion. | Suggestions at medium risk or above (confidence below "alta", or "contradiz") also go to the Inbox and count in "precisam de você"; the rest stay inline. | Design (the orchestrator's default, §19.9; the owner may change it). | **A9** |
| 24 | Showing confidence | D11: relation visibility comes only from `note-relation-sql.ts`. | Below 0.6 a suggestion is not shown. | D11: the UI hides nothing by confidence. Below 0.6 the word is "confiança baixa" (§5.11). | No |
| 25 | Settings content | D17: registry v2 of today's settings in seven sections. The T107 proposal leaves density and reading size out. | Geral e aparência also holds Densidade, Abrir em and Reduzir animações. | D17 and T107 decide the rows; the design binds the frame, labels and states (§7.6). | No |
| 26 | Density toggle | The owner's element list includes a density toggle; D17 adds no entry. | A toggle in the Library header plus a row in Ajustes, showing the same value. | The Library header only, kept per device in `memora.workspace.v1` (§7.3). | No |
| 27 | Graph colours and canvas | D19: `--graph-topic-1..12`, each ≥ 3:1 on the surfaces, adjacent indices ΔE ≥ 20 *(cal.)*. | `--topic-cat-1..5`. The canvas reads the theme tokens, and `--graph-*` retires. | D19's name and count; the design's values for 1-5. Design: the canvas reads the theme, and the dark-canvas tokens retire (§4.1). | No |
| 28 | Token additions | Spec T108: at most 8. T124 may add motion and focus tokens, including `--focus`. | About 20 new names, including layout tokens, `--type-number` and `--topic-cat-*`. | §4.10: seven tokens plus D19's family. Layout values are typed configuration (§4.9). The focus ring is `--accent`. | No |
| 29 | Clocks and pollers | D16: 0 `setInterval`, 0 poll loops, and J-idle's runtime proof. | Relative times and estimates ("agora mesmo", "faltam cerca de 3 min"). | D16: computed when the view renders and refreshed on the next event (§5.12). | No |
| 30 | Navigator per destination | D8: one navigator per destination (⌘\). Spec: on by default in Explore and Library. | A navigator in Explore only. The Library uses a filter bar and a territory bar. | Design (layout). ⌘\ toggles where a navigator exists. | No |
| 31 | Title bar | Spec T135: back and forward for the focused panel, the Cmd-K field, the Activity pill and Ask. | Destination name, omni trigger, status slot and Adicionar. No back, and no Ask button: the omni reads "Buscar, abrir ou perguntar…". | Design. | No (spec S2) |
| 32 | Hoist key | `rules/frontend.md`: no Option-Arrow shortcut. | ⌥→ and ⌥← hoist the tree. | The rule: hoist is a menu command and a Cmd-K action (§5.3). | No |
| 33 | Map tab names | D19 and D20: Map › Relations and Map › Shape. | Mapa with the tabs Árvore and Grafo ("never Forma"). | Design copy; the ids stay `shape` and `relations` (§7.5). | No |
| 34 | Tree and list labels | (orchestrator review, gate D) | Cut in the middle of a word ("Fermentaç…alcoólica"). | Cut only at word boundaries or at the tail, with the full title on hover and focus (§5.3). | No |
| 35 | Home's fourth column | T130's digest has `questions` but no resurfacing schedule. | Para relembrar (a resurfaced note). | Perguntas recentes in F5; Para relembrar waits for resurfacing data (§7.1). | No |

### 20.2 Proposed amendments to docs/f5-decisions.md

- **A1 (D8, panel widths).** Replace "Panel minimum 420 px *(cal.)*; overflow collapses to 40 px spines" with:
  - "The top panel keeps at least 568 px *(cal.)*, the reading measure plus padding (552 px at a 960-999 px window).
  - The panel left of it shows in a compact form (216-240 px) when the stack is at least 848 px wide.
  - Other panels collapse to 40 px spines, and more than 6 spines merge into one '+N' spine."

  Spec 3.1 follows: `layout(stack, viewportWidth, topMin = 568)` returns `{ panel; mode: "full" | "compact" |
  "spine" }[]`, and T136 tests at 960, 1280 and 1440 px.
- **A2 (D8, context panel).** Replace "overlaid below 1200 px" with "docked from 1280 px; below that, a 40 px strip that
  opens as an overlay".
- **A3 (D15, hover and citations).** Replace "A Radix HoverCard after 300 ms *(cal.)* on any object link or citation
  chip, showing the cited passage for an anchored address" with:
  - "A Radix HoverCard after 300 ms *(cal.)* of hover or keyboard focus on any object link.
  - A citation chip instead expands its passage in place in the answer's sources list: the Evidence tab, a note's
    margin, or a passage tray at the panel foot below 1280 px. It never shows a card over the text.
  - Relation rows in the context panel show no card."
- **A4 (D15, quick-look).** Replace "Space opens quick-look" with "Space (outside text fields) or Cmd-Y (anywhere,
  including Cmd-K) opens quick-look, a centred non-modal sheet; ↑/↓ peek the next row and Esc closes it".
- **A5 (D31, the tab's label).** Append: "The Activity tab is labelled History (pt-BR 'Histórico'); 'Activity' names
  only the global pill and drawer. Connections, Evidence and Ask are shown; the other three sit under 'More'."
- **A6 (D9, the first source).** Replace "After onboarding, Home opens with the first source's panel pushed." with
  "Choosing the first source in onboarding opens Explore with that Source panel pushed, so the navigator shows the tree
  being born; until then, Home is the first-run surface."
- **A7 (D32 and the Add flow).** In D32, replace "reached from the Add sheet" with "reached from the Add menu ('More
  import options…')". Add to D32:
  - "Add's main button (Cmd-N) opens the file picker directly, and a window drop imports at once.
  - The chevron menu offers a link, a note and the import mode.
  - The chosen Source is pushed onto Explore's stack at once, with no 'Open' toast."
- **A8 (Inbox keys; replaces F4 D29's key list for F5).**
  - j/k and ↑/↓ move, and Enter opens.
  - a accepts: apply a structure proposal, or keep a relation.
  - Backspace removes: a veto, so the decider never suggests that relation again.
  - x only dismisses: the item leaves the Inbox and nothing changes. It is offered only where a dismiss verb exists.
  - e edits names before applying a structure proposal, only where the writer supports it.
  - r retries, u undoes, and ? shows the keys.
- **A9 (Inbox routing; a new decision, default per design §19.9).**
  - A suggested relation whose confidence is below "high" (typed configuration, 0.85 *(cal.)*), or whose stance is
    contradicts, appears in the Inbox as well as inline, and counts in "needs you".
  - Other suggestions are inline only.
  - Visibility still comes only from `note-relation-sql.ts`.
  - The owner may change the threshold.
  - The orchestrator names the card that extends the Inbox read model (no F5 card owns it today).

### 20.3 Card adjustments (the spec, not the decisions)

- **S1 (spec 3.1; T120, T136).**
  - `layout()` gains the `compact` mode and the `topMin` floor (A1).
  - `WorkspaceState` gains the context tab per kind, the hoist, the density and the scroll per panel.
- **S2 (T135).**
  - The title bar is §5.2: no back or forward, and no Ask control.
  - The navigator is on by default in Explore only.
  - The pill's undo extension (§5.2) extends the existing `ActivityHost`.
- **S3 (T124).**
  - No `--focus` token: the ring is `--accent`.
  - The tokens are those of §4.10.
  - Peek needs a non-modal sheet primitive.
- **S4 (spec 3.3; T129).** `locate(question)` works as follows:
  - **Topic scope:** the scope topic's chain.
  - **Library or source scope:** the chain of the topic where most of its cited notes are primarily placed, with
    deterministic ties.
  - **No citations:** `null`, shown as "Sem lugar".
- **S5 (T130).** `home.digest` gains two fields:
  - `gardener`: the count and the top 3 of the change-sets since `since`;
  - the arrived notes' placed and unplaced counts.
  The briefing's truth conditions (§7.1) need them.
- **S6 (T131, T149).**
  - `library.rows` status gains `needsYou` (with a reason) and `storedOnly`.
  - A territory facet gives the counts per root topic plus Sem lugar.
  - T149 adds the Perguntas tab.
- **S7 (T150).** Per A7: a split button and a menu, with no sheet; a drop imports at once with the current mode; the
  estimate moves to the generation strip.
- **S8 (T145).**
  - ⌥↵, ⇧↵ and ⌘Y.
  - No ranking-bias line.
  - "mostrar mais (n)" opens the search results panel filtered to that kind.
- **S9 (T142 and the Inbox keys).** `inbox-keys.ts` gains Backspace and `e` (A8).
- **S10 (T146).** The stage copy and the stale line of §6.4.
- **S11 (T148).** Perguntas recentes as the fourth column; no resurfacing.
- **S12 (T151).**
  - `--graph-topic-1..12`, with the design's values for 1-5.
  - The canvas reads the theme.
  - The dark-canvas tokens retire, and the `tokens.css` header comment changes with them.
- **S13 (T159-T166).** No Densidade, Abrir em or Reduzir animações entries.

### 20.4 What the rules changed in the design

- **Hoist:** ⌥→ and ⌥← are dropped (`rules/frontend.md`: no Option-Arrow).
- **⌥1-⌥6:** never fire in a text field (`rules/frontend.md`: shortcuts never collide with editing).
- **Peek:** non-modal (`rules/frontend.md`: previews never trap focus or answer ⌘W).
- **Icon-only controls:** every one has a tooltip and an accessible name (`rules/frontend.md`; orchestrator review).
- **Confidence:** no UI filter on relations. This one comes from D11 rather than a rule: `note-relation-sql.ts` is the
  single visibility predicate.
- **Copy:** every string goes through `@app/i18n` in the five locales. The pt-BR text here is the pt-BR source, and the
  other locales are written to the same rules (§13).

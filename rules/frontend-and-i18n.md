# Frontend, accessibility, and i18n rules

Load this rule for renderer UI, styles, user-visible messages, themes, or
locales.

## Product interface

- Build the working knowledge-management experience, not marketing pages.
- Use React 19, Tailwind CSS 4, vendored shadcn/ui components, and Lucide icons.
- Prefer dense, clear, utility-oriented layouts with stable dimensions for
  toolbars, lists, trees, grids, buttons, and tiles.
- Keep the desktop shell constrained to the viewport. The sidebar navigation
  and active workspace scroll independently without scroll chaining.
- Library hierarchy navigation participates in browser history so system or
  mouse back controls traverse source levels, and each opened level starts at
  the top of the workspace.
- Use the correct control for the data: toggles/checkboxes for booleans,
  select/menu for choices, tabs for views, and inputs/sliders/steppers for
  numeric values.
- Icon-only or non-obvious controls require accessible labels/tooltips. Do not
  encode meaning by color alone.
- Prevent text overlap and preserve keyboard/focus behavior. Dialogs restore
  focus, disclose impact, and provide cancellation when work can be canceled.
- Important components cover relevant empty, loading, error, partial, and
  success states. Hierarchical trees support keyboard navigation and
  multiselection semantics.
- Library and subitem browsing use bounded database pages; catalog search
  includes child sources, creators and identifiers without requiring AI or a
  document. Breadcrumbs come from canonical ancestry, not a loaded page.
- Library search cards disclose whether text, semantic similarity, or both
  drove the ranking, show the strongest score, and name the parent source for a
  matching subitem.
- Source detail uses keyboard-accessible tabs. Subitems can be added in context
  and selected for one processing batch. Editing saves separately from processing.
  After a chevron card is expanded, source detail waits for its height transition
  and scrolls only when needed to fit the entire card in the visible scroll
  viewport; oversized cards align to the top.
- Source detail includes a knowledge-graph tab for its entities, semantic
  relations, and connections to other sources. Cross-source connections open
  the related source through normal Library history navigation. Repeated
  entities, semantic relations, and related sources are grouped into one
  expandable card, with the underlying connections shown as compact details.
- The global knowledge-graph dashboard uses WebGL rendering, automatic
  community-aware d3-force layout in a presentation-only Web Worker, with
  Zod-validated messages. The same individual nodes remain visible at every
  zoom level; zoom reveals labels and relation detail continuously without
  replacing items with community aggregates. Louvain groups guide the physics
  without adding synthetic nodes or interaction edges to the simulation.
  Node and edge emphasis starts after a 100 ms dwell on the same target and
  fades over a short transition. Hovering a node emphasizes it, its neighbors
  and incident edges; hovering an edge emphasizes only that edge and its
  endpoints. Emphasized relations transition to light red. All unrelated
  nodes, edges and labels desaturate to the same neutral gray and fade to
  near-transparency; leaving the target fades the original palette and opacity
  back in. During node hover, unrelated nodes and non-incident visible edges
  finish the fade at an absolute alpha of 0.10, independent of zoom (not 10%
  of their resting opacity). Connected nodes and incident edges retain their
  emphasis. Hover behavior remains suspended during drag.
  Node, hovered-node and edge WebGL programs must premultiply RGB by the
  corrected alpha in the normal render pass to match Sigma's ONE /
  ONE_MINUS_SRC_ALPHA blending. Picking colors must remain unmodified. Verify
  transparency at the rendered-pixel boundary, not only in reducer RGBA strings.
  Target dwell is independent of pointer movement inside the target, while detail previews appear only after
  one second of pointer inactivity and leave with a short fade. Atomic-note
  previews include the note body. Item labels wrap, and their opacity plus edge
  and edge-label opacity increases continuously with zoom. Edge thickness stays
  stable at a 1.8 screen-pixel default thickness across zoom levels. Relation
  picking uses a separate invisible 10-pixel interaction stroke so hover does
  not require pixel-perfect aiming. Labels already revealed while zooming in do not
  disappear at a closer level. Source pairs render as one unlabeled edge; its
  detail card lazily loads and groups all represented source-connection details.
  Atomic-note
  relation labels use the active locale. When a hovered edge's normal label is
  outside the viewport, a temporary label follows the pointer. Hover information
  cards measure their rendered size, flip around the pointer when needed, and
  remain bounded by the visible graph viewport, including after async content
  changes. Hovered nodes render
  their labels, incident edges, and incident edge labels fully opaque after the
  short emphasis transition. Node and background dragging cancel all pending
  hover/preview timers and disable tooltip activation and hover emphasis until
  release. Dragging pins the node to the pointer and reheats
  the entire simulation; connected motion propagates through the network and
  cools with damping after release. Worker snapshots must continue to update
  other nodes while pointer commands are in flight; stale pointer coordinates
  must not overwrite the latest dragged position. Physics wakes on the first
  drag movement, without requiring pointer inactivity.
  Wheel zoom is anchored at the cursor and driven by bounded velocity impulses
  in logarithmic scale. It responds on the first animation frame, then decays
  smoothly to rest when input stops. Normalize delta units continuously without
  hard device/sensitivity thresholds or an accumulated destination backlog.
  Input magnitude and cadence determine the current velocity so fast wheel
  gestures and free-spinning bursts remain proportional while slow gestures
  retain fine control. High-magnitude input receives a continuous boost of up
  to approximately 3x without materially changing low-magnitude precision.
  Do not cumulatively accelerate consecutive wheel events
  or flatten sustained free-spin input against a velocity ceiling: macOS wheel
  momentum already arrives as a changing event stream. Limit per-frame travel,
  use only a brief synthetic decay after input stops, discard catch-up after
  long stalls, reverse direction immediately, retain Shift precision, and ease
  into camera bounds. At the zoom-out boundary, center the complete graph and
  keep its longest visible dimension at approximately 50% of the viewport.
  Motion is time-based for consistent 60/120 Hz behavior. Wheel zoom has exactly
  one camera writer: intercept the native wheel event in the DOM capture phase
  and stop it before Sigma's mouse captor can start its fixed-duration default
  animation. Sigma's wheel animation must never run concurrently with the custom
  velocity controller; regression coverage must detect secondary camera updates
  that overwrite a wheel frame.
  Repulsion, link attraction, preferred link
  distance, and center attraction are independently adjustable. Communities
  form through soft forces; orphan nodes favor a broad peripheral band and
  circular containment never clamps node coordinates to a hard boundary.
  Physics sleeps after settling, with a bounded run as a fallback, and wakes
  for interaction or force changes. Camera normalization remains fixed during
  simulation and drag. Source clicks open source detail, and
  atomic-note clicks open and focus that note in its source's Atomic Notes tab.
  Returning from either destination restores the graph mode, camera position,
  zoom, camera bounds, force settings, and automatic or manually adjusted node
  positions exactly when the graph data has not changed; restoration does not
  automatically restart the simulation.
- Manual textual intake uses a reusable Markdown editor with write, preview,
  and split views. Hierarchical roots also expose an ordered subitem composer;
  existing materialized children remain independently editable from the Library.
- Metadata lookup cancels stale UI results, exposes loading/empty/failure states,
  and keeps manual entry available. Applying a catalog candidate explicitly
  selects its title; other manually entered fields remain protected.
- Remote model and AI profile creation are disclosed only after an explicit
  add action, in a dismissible dialog. AI profile layouts adapt to the available panel width;
  lists, editors, and actions must stack before their content overlaps.
- AI profiles start from a selected model. Per-task overrides use progressive
  disclosure with an explicit reset to inherited model defaults.
- A cold start of a local embedding model presents an animated, non-dismissible
  loading dialog and closes it automatically when the runtime reports ready or
  failed. Already-resident models do not show the dialog.

- Non-AI external API settings live in the dedicated External Services settings
  page, including metadata catalogs, provider selection, and Google Books
  credentials. AI provider/model settings retain their own scopes; local
  Gateway and Obsidian integration settings remain under Connections.

## Internationalization

Never hardcode product copy in application components, clients, menus, command
names, notifications, dialogs, toasts, placeholders, tooltips, empty states,
job statuses, or user-visible backend errors.

- All product copy goes through `@app/i18n`.
- Supported locales are `en` (fallback/default), `pt-BR`, `it`, `fr`, and `es`.
- Add or update every locale in the same change. Preserve typed key parity.
- Technical identifiers—protocol names, event IDs, enum values, table names,
  routes, and internal constants—are not product copy unless displayed to the
  user.
- Obsidian UI follows host conventions. Chrome UI stays appropriate for an
  extension surface. Shared visual language must not break the host platform.

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
  Zod-validated messages. The same individual nodes in the active projection
  remain visible at every zoom level; zoom reveals labels and relation detail continuously without
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
  disappear at a closer level. In the entity view, source pairs render as one
  unlabeled edge; its detail card lazily loads and groups all represented
  source-connection details. The default conceptual source view uses the
  atomic-note icons and stacked relationship cards in `rules/source-relations.md`.
  Atomic-note relations use compact, distinctly colored icon markers instead
  of text on the canvas. A localized Filters badge below the conceptual-source
  and atomic-note graphs opens the icon-to-label panel with full-row switches.
  Use colored icons for enabled types and gray icons for disabled types, without
  visible checkboxes. Expose switch state to assistive technology and support
  keyboard activation and visible focus.
  Filtering uses loaded data, fades disabled connections and nodes with no active
  connections over 220 ms, and restores them when enabled. Preserve graph topology,
  positions and camera; hidden items cannot be picked. Grouped edges remain when
  another relation type is active. Canvas markers and filter entries use
  the same Lucide icon geometry and color for every canonical relation type;
  the supports marker uses a plain check because the marker supplies the circle.
  Marker circles have an approximately 17.6-pixel diameter so Lucide icons retain clear internal spacing.
  Relation information cards repeat that icon before the translated label.
  Atomic-note relation hover cards use the same compact visual hierarchy as
  source-relation cards and show the persisted explanation, localizing known
  explanation keys while preserving generated prose.
  Note-reference tags render as safe numbered cyan/violet badges matching
  the displayed endpoints in both graph cards and the Library relation list;
  resolve by canonical ID, never by alias or UUID sort order. Labels use the active
  locale in the legend and relation details. When a hovered edge's normal label is
  outside the viewport, a temporary label follows the pointer. Hover information
  cards mount invisibly for measurement and start their entrance animation only
  after their final position is calculated. Async relation cards wait for loaded,
  empty or error content before revealing; apply resize positioning before paint.
  Cards measure their rendered size, flip around the pointer when needed, and
  accept pointer interaction. Entering a card cancels pending dismissal and keeps
  it open while the pointer remains inside. Wheel events scroll overflowing card
  content natively. A protected pointer corridor from the original hover anchor
  to the measured card prevents dismissal, including slow movement and pauses
  across the gap; leaving the corridor releases the popup.
  Wheel events never propagate into graph zoom; contain scroll chaining.
  Cards remain bounded by the visible graph viewport, including after async content
  changes. Any wheel, button, fit, or focus zoom dismisses pending and visible
  node or relation information cards without closing the relation legend. In Sources mode,
  a toolbar toggle selects an interactive graph preview (default) or the previous
  grouped text card. Graph previews use canonical entity IDs and directed semantic
  relations and include shared entities even without semantic edges. Only graph
  previews fill the entire graph viewport; textual cards remain compact. Graph
  previews fit all nodes initially and after the fit action until the user interacts,
  including while physics settles or the viewport resizes. Connection previews
  release their renderer, workers and pending frames before React removes the
  preview canvas container; teardown must be idempotent. For connection previews,
  Sigma's forced WebGL context loss is deferred across a paint opportunity after
  canvas removal, with a bounded fallback when animation frames are suspended.
  Workers, listeners, animations and renderer programs still stop immediately;
  context loss is not disabled and GPU resources are not retained indefinitely.
  Their edges use a stable
  2.1 screen-pixel thickness, with explicit arrowheads that retain readable fixed
  screen dimensions during zoom. Preview nodes use the main graph's degree-based
  size formula and zoom scaling; node and relation typography shares the main
  graph's font families, weights and sizes. They use
  the same hover dwell and fade as the main graph: nodes emphasize neighbors and
  incident relations; relations emphasize only their endpoints. Other nodes, edges,
  arrowheads and labels desaturate and fade. Relations have the same invisible
  10-pixel picking stroke, excluded from physics and node sizing. Dragging suspends
  emphasis, and leaving the target restores the resting palette.
  They use
  the main graph's worker physics and force settings with independent node dragging,
  pan and cursor-anchored wheel zoom. Entering a preview cancels parent wheel momentum;
  preview gestures never zoom the parent or dismiss the preview. Previews stay open
  when the pointer leaves and close through top-bar Back/Close buttons, Escape, or
  the system/mouse Back action, returning to the underlying graph.
  In Sources mode, hierarchical source items are grouped by their root source by
  default. A collapsed root displays its descendant count and aggregates descendant
  connections without losing their weights or details. The count appears in a small
  badge on the source node. Subitem-count badges follow the node label's zoom
  reveal and hover opacity, shrinking and fading out when zooming out and
  returning to full size on emphasis. Hover information cards remain informational; two compact
  node-anchored actions expand or collapse that source in place and open its hierarchy
  with only directly connected source neighbors in a separate overlay graph. The
  pointer corridor between the source node and both actions keeps the actions open
  indefinitely, including during pauses; leaving that region restores delayed
  dismissal. This corridor must not intercept node clicks or canvas dragging.
  The overlay keeps the main graph mounted and frozen so closing it restores the exact
  camera and node positions. The user can also switch the entire graph between grouped
  and fully expanded source projections. Hierarchy grouping is explicit UI state and
  never changes automatically with zoom. Each hierarchy level expands its direct
  children independently; collapsing a source hides all its descendants, including
  expanded nested branches, and aggregates their connections and detail counts into
  that source. Nested expansion choices survive an ancestor's collapse. In-place
  projection changes keep the live renderer, camera, normalization bounds, force
  settings and surviving node positions; newly visible children start near their
  parent and physics reheats from those coordinates so the network adjusts smoothly.
  Hierarchy previews also accept nested sources and show their complete subtree
  with only directly connected external neighbors.
  Their semantic connections use the same wide relation picking, hover dwell,
  emphasis and lazy details as the main graph, honoring the graph/text preview
  setting. Structural hierarchy links do not open semantic relation details.
  Opening connection details keeps the hierarchy renderer mounted and freezes its
  camera and positions. Close, Escape and Back dismiss only the innermost open
  view: connection details return to the source hierarchy, and closing that
  hierarchy returns to the main graph. Each return preserves the previous view.
  Hovered nodes render
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
  Display settings expose a persistent wheel-zoom sensitivity from 0.5x to
  1.5x; its 1x midpoint preserves the calibrated default graph behavior.
  Graph force controls are hidden by default and open as a fading popover from
  a sliders button immediately to the right of the fit-to-view action.
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
- Graph processing settings expose separate similarity thresholds for relation types and
  entity identities, explain their provisional defaults and distinguish similarity from
  certainty. Explain the embedding requirement and conservative identity confirmation.
- Supported locales are `en` (fallback/default), `pt-BR`, `it`, `fr`, and `es`.
- The content-generation language is separate from interface language. Both initially
  follow the supported OS locale with English fallback; subsequent changes are independent.
  Display settings and the Data and Security relation-description card expose the global
  content language. The card offers missing-only and full description regeneration,
  persisted status/counts, cancellation, retry, and empty/error/success feedback.
- Add or update every locale in the same change. Preserve typed key parity.
- Technical identifiers—protocol names, event IDs, enum values, table names,
  routes, and internal constants—are not product copy unless displayed to the
  user.
- Obsidian UI follows host conventions. Chrome UI stays appropriate for an
  extension surface. Shared visual language must not break the host platform.

## Settings navigation

- In the conceptual source graph, the relation window defaults to disabled;
  the entity-connection view keeps its independent enabled default. Every source
  in the conceptual view exposes a node-anchored entity-graph action, including
  sources without children. It opens the source's canonical entities and directed
  relations in the existing interactive preview renderer. Keep the underlying
  graph mounted and frozen; Back, Escape and Close dismiss the top preview and
  preserve the previous camera and node positions. Support loading, empty and
  retryable error states.

- The introductory settings card and global status summary appear only in the
  Overview dashboard. Other settings dashboards start with their own scope header.

## Matching settings

- The Matching dashboard starts with a preset selector. The recommended preset
  is visibly identified and its values are read-only; users create a preset from
  the recommendation, duplicate any preset, and edit, rename, or delete custom
  presets. Deletion requires confirmation and the built-in recommendation cannot
  be deleted. Existing custom matching values remain available. Cover invalid
  names, save failure rollback, the custom-preset limit and the absence of custom
  presets. Preset changes apply all matching fields together; delayed save
  responses must not replace newer edits.
- Every matching variable has a compact accessible reset action, including
  numeric limits, signal weights and toggles. Each reset restores that variable's
  value from the built-in recommendation; group resets use the same snapshot.

- Knowledge-note matching, relation-type similarity, and entity-identity
  similarity thresholds live in their own Matching settings dashboard.
- Every matching threshold uses a slider with a visible draft value. Persist
  only when the pointer is released or a keyboard adjustment ends; canceled
  pointer gestures discard the draft. Each slider has an accessible compact
  action that restores and saves its recommended value.

- Matching includes a collapsed Advanced matching section for note candidate
  limits, graph-only reservation, RRF, signal weights, validation policy and
  per-execution/output limits; identity confirmation candidates/batching; and
  source evidence/context/output limits. Each group provides a default reset.
  Numeric fields commit on blur/Enter and discard edits on Escape. Reject
  all-zero weight groups with visible feedback. Every slider has a visible
  text label as well as its accessible name and numeric value.

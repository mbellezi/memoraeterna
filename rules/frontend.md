# Frontend, accessibility and i18n

Load for renderer components, styles, themes, product copy, locales,
accessibility, visualizations or user-visible backend messages.

## Stack and structure

- React 19, Tailwind CSS 4, vendored shadcn/ui components and Lucide icons.
  Build the working knowledge tool, not marketing pages.
- The target information architecture (destinations, workspace zones, object
  pages) is described in `docs/plan.md`. Objects are addressed by stable
  UUID-based `memora://` references, never by titles (target F5).
- New code receives live updates through pushed events, not polling. Large lists
  and trees use bounded pages or virtualization.
- Background state is shown quietly (status indicators, drawers), not by
  blocking the reading surface.
- Views that hold navigation, filters or scroll (Library, Wiki) stay mounted
  while hidden. A page resolves its own links in one request per revision, and
  a refresh that found no change neither re-renders nor re-requests.

## Visual language

- Use semantic design tokens only. New code adds no raw palette classes and no
  arbitrary font sizes; the quality ratchet only lets existing ones decrease.
- Colour carries meaning (object type, relation stance, state) and is never the
  only signal: pair it with a glyph, icon or label.
- Text meets WCAG AA contrast (4.5:1, glyphs and large text 3:1) in light and
  dark themes. The graph and canvases read colours from tokens.
- Fonts are bundled for offline use; no remote font or stylesheet is used.
- Motion is short and functional and respects `prefers-reduced-motion`.

## Accessibility

- Icon-only or non-obvious controls have accessible names and tooltips.
- Everything is keyboard-operable with visible focus. Trees use one roving tab
  stop (arrows, Home, End); dialogs trap and restore focus and close with Escape.
- Single-key shortcuts never fire while typing in inputs or editors, and app
  shortcuts do not collide with platform conventions.
- Canvas and WebGL views (graphs, icicles, maps) offer a text or table
  alternative. Live updates that matter are announced through live regions.
- Undo affordances stay visible long enough to use and are reachable by keyboard.
- Use the correct control for the data: toggles for booleans, selects for
  choices, tabs for views, numeric inputs or sliders for numbers.

## States and copy

- Every important view covers loading, empty, error and success states (plus
  partial or waiting states). Failures stay visible and retryable.
- Product copy is written from the user's side: say what is happening and what
  the user can do. Internal state-machine terms, raw IDs and UUIDs never appear
  in normal UI; they belong in Diagnostics.
- Destructive actions disclose their scope and require confirmation; cancelable
  work offers cancellation.
- Model-generated text is rendered as safe React nodes, never raw HTML.
  Reference tags resolve by canonical ID and render as safe links or badges;
  unknown references stay inert.

## Internationalization

- Never hardcode product copy in components, clients, menus, notifications, job
  statuses or user-visible backend errors. All copy goes through `@app/i18n`.
- Supported locales are `en` (fallback), `pt-BR`, `it`, `fr` and `es`. Add or
  update every locale in the same change and keep typed key parity.
- The content-generation language is separate from the interface language; both
  initially follow the supported OS locale with English fallback.
- Technical identifiers (protocol names, enum values, table names, routes) are
  not product copy unless displayed.
- The Obsidian plugin and the Chrome extension follow their host conventions.

## Visualizations

- Layout, positions and community assignments are presentation state, never
  canonical identity. Layout physics runs in a renderer Web Worker with
  Zod-validated messages.
- Graph views show context around a focus and expand on demand instead of
  defaulting to a global hairball; global views stay bounded.
- Renderers, workers, listeners and animation frames are disposed when a view
  unmounts; teardown is idempotent. They are rebuilt only when their data or
  mode changes, never because a parent passed a new callback.

## Visual checks

- Check UI in the DEV app at the normal opening window size (never full screen),
  at the minimum supported window size, and in both themes.

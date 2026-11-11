# Frontend, accessibility and i18n

Load for renderer components, styles, themes, product copy, locales,
accessibility, visualizations or user-visible backend messages.

## Stack and structure

- The target information architecture (destinations, workspace zones, object
  pages) is described in `docs/plan.md`; views open objects by ID or address, never by title.
- New code receives live updates through pushed events, not polling. Large lists
  and trees use bounded pages or virtualization. Background state is shown
  quietly (status indicators, drawers), never by blocking the reading surface.
- Views that hold navigation, filters or scroll (Library, Wiki) stay mounted while hidden. A hidden view loads nothing, holds no open modal and ignores history events; shown again it refreshes in place only when its key is unchanged and its last load succeeded, otherwise a failed load stays visible and retryable.
- A page resolves its links in one batch per revision and evidence-currency change; an opened note is read again. A refresh that found no change neither re-renders nor re-requests, and a failed resolution backs off.

## Visual language

- Use semantic design tokens only: `tokens.css` is the one source of colour, type,
  spacing, radius and motion values. New code adds no raw palette classes, hex
  colours or arbitrary font sizes (the quality ratchet only lets them decrease).
- Colour carries meaning (object type, relation stance, state) and is never the
  only signal: pair it with a glyph, icon or label.
- Text meets WCAG AA contrast (4.5:1, glyphs, boundaries and large text 3:1) in
  light and dark; `npm run contrast` (part of `npm run check`) enforces it for
  every token pair. Fields and buttons bound themselves with `--border-strong`,
  never `--border-subtle`. The graph and canvases read colours from tokens.
- Inter (interface) and Source Serif 4 (reading surfaces) are bundled offline; no
  remote font or stylesheet is used. Motion is short and functional; durations
  are tokens, zero under `prefers-reduced-motion`.
- Themes: System (default, follows the OS live), Light and Dark. Check UI in DEV
  at the normal opening and minimum window sizes (never full screen), in both themes.

## Accessibility

- Icon-only or non-obvious controls have accessible names and tooltips.
- Everything is keyboard-operable with visible focus. Trees use one roving tab
  stop (arrows, Home, End); dialogs trap and restore focus and close with Escape.
- Hover cards and previews are non-modal: they also open on keyboard focus, close with
  Escape, never trap focus and never answer Cmd-W.
- Single-key shortcuts never fire while typing in inputs or editors, and app
  shortcuts do not collide with platform or editing conventions (no Cmd-. Cmd-E
  Cmd-I or Option-Arrow). The localized application menu owns them: Cmd-W closes
  the topmost dialog or panel, does nothing when nothing is open and never closes
  the window; Cmd-[ and Cmd-] follow the history. No move drops unsaved edits unasked.
- Canvas and WebGL views (graphs, icicles, maps) offer a text or table
  alternative. Live updates that matter are announced through live regions.
- Undo affordances stay visible long enough to use and are reachable by keyboard.
- Use the correct control for the data: toggles for booleans, selects for
  choices, tabs for views, numeric inputs or sliders for numbers.

## States and copy

- Every important view covers loading, empty, error and success states (plus
  partial or waiting states). Failures stay visible and retryable.
- Every surface in `workspace/surfaces.ts` has a screen module with loading, empty, error and success states over a fake `window.app` (`npm run screens -- --check`).
- Product copy speaks from the user's side: what is happening and what they can
  do. State-machine terms, raw IDs and UUIDs never appear in normal UI (Diagnostics).
- Cancelable work offers cancellation (destructive actions: `security-privacy.md`).
- Model-generated text is rendered as safe React nodes, never raw HTML.
  Reference tags resolve by canonical ID and render as safe links or badges;
  unknown references stay inert.

## Internationalization

- Never hardcode product copy in components, clients, menus, notifications, job
  statuses or user-visible backend errors. All copy goes through `@app/i18n`.
- Supported locales are `en` (fallback), `pt-BR`, `it`, `fr` and `es`. Add or
  update every locale in the same change and keep typed key parity.
- The content-generation language is separate from the interface language; both
  initially follow the supported OS locale with English fallback. `<html lang>`
  follows the interface language.
- Technical identifiers (protocol names, enum values, table names, routes) are
  not product copy unless displayed.
- The Obsidian plugin and the Chrome extension follow their host conventions.

## Visualizations

- Layout, positions and community assignments are presentation state, never
  canonical identity; layout physics runs in a renderer Web Worker.
- Graph views show context around a focus and expand on demand instead of
  defaulting to a global hairball; global views stay bounded. A relation graph
  draws a suggestion (suggest band, not kept) dashed and softer than an applied
  or kept one, and an arrow only where the owner or a decider gave the direction.
- Renderers, workers, listeners and animation frames are disposed when a view
  unmounts; teardown is idempotent. They are rebuilt only when their data or
  mode changes, never because a parent passed a new callback.

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
- Source detail includes a knowledge-graph tab for its entities, semantic
  relations, and connections to other sources. Cross-source connections open
  the related source through normal Library history navigation. Repeated
  entities, semantic relations, and related sources are grouped into one
  expandable card, with the underlying connections shown as compact details.
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

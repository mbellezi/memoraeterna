# Frontend, accessibility, and i18n rules

Load this rule for renderer UI, styles, user-visible messages, themes, or
locales.

## Product interface

- Build the working knowledge-management experience, not marketing pages.
- Use React 19, Tailwind CSS 4, vendored shadcn/ui components, and Lucide icons.
- Prefer dense, clear, utility-oriented layouts with stable dimensions for
  toolbars, lists, trees, grids, buttons, and tiles.
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

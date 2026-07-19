# Project licensing rules

Load this rule for project licensing, package license metadata, distribution
notices, or third-party license exceptions.

## Project code

- The repository default is the GNU General Public License version 3 or any
  later version (`GPL-3.0-or-later`). The root `LICENSE` contains the complete
  GPLv3 license text.
- The Chrome extension, desktop application, native helper, and internal
  packages use the repository default unless a closer license declaration
  explicitly overrides it.
- Package manifests must carry the SPDX expression that applies to the package,
  and distributed source and binaries must retain the applicable notices and
  license texts.

## Obsidian plugin exception

- `apps/obsidian-plugin` is dual-licensed under the recipient's choice of the
  MIT License or Apache License 2.0 (`MIT OR Apache-2.0`). Its directory contains
  both complete license texts.
- `packages/i18n` and `packages/integration-contracts`, which are compiled into
  the Obsidian plugin, are additionally available under MIT or Apache-2.0. Their
  SPDX expression is `GPL-3.0-or-later OR MIT OR Apache-2.0` so GPL remains
  available to the rest of the application.
- No other repository code inherits the Obsidian plugin's permissive licensing
  merely by communicating with or packaging alongside the plugin.

## Third-party material

- Dependencies, models, native runtimes, generated SBOM entries, and other
  third-party material retain their own licenses. The project license never
  replaces or weakens those terms.
- Release staging must include all notices, source offers, installation
  information, and other materials required by the licenses of the distributed
  components.

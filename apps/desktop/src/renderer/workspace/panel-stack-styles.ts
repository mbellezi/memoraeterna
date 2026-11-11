/**
 * The panel stack's stylesheet (design record §3, §5.5, §8, §18). Widths are the shell's custom
 * properties, which `layoutCustomProperties` writes from `layout-config.ts`; the container query is
 * that module's `prevShowsAt` (848 px at every tier). `PanelStack.test.tsx` parses this text and
 * fails when either drifts from the configuration. It is a module, not a `.css` file, so the test
 * reads the same text the page gets (`PanelStack` mounts it once as a hoisted `<style>`).
 */
export const panelStackStyles = `
.panel-stack {
  display: flex;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--surface-canvas);
  container-type: inline-size;
  container-name: stack;
}

.panel-stack__item {
  display: flex;
  min-width: 0;
  min-height: 0;
}

.panel-stack__item[hidden] {
  display: none;
}

/* The top panel takes the rest of the stack; layout() keeps it at --top-min or more. */
.panel-stack__item[data-mode="full"] {
  flex: 1 1 0;
}

.panel-stack__item[data-mode="full"] > * {
  flex: 1 1 auto;
}

/* The previous panel: its compact form when the stack has room, else its spine twin. */
.panel-stack__item[data-mode="compact"] {
  display: none;
  flex: 0 0 var(--prev-w);
}

.panel-stack__item[data-mode="compact"] > * {
  flex: 1 1 auto;
}

.panel-stack__spine[data-prev-twin] {
  display: flex;
}

@container stack (min-width: 848px) {
  .panel-stack__item[data-mode="compact"]:not([hidden]) {
    display: flex;
  }

  .panel-stack__spine[data-prev-twin] {
    display: none;
  }
}

.panel-stack__spine {
  display: flex;
  flex: 0 0 var(--spine-w);
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  min-height: 0;
  padding: var(--space-3) 0;
  overflow: hidden;
  border: 0;
  border-right: 1px solid var(--border-subtle);
  background: var(--surface-canvas);
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
  transition: background-color var(--motion-fast) var(--ease-out);
}

.panel-stack__spine[data-side="right"] {
  border-right: 0;
  border-left: 1px solid var(--border-subtle);
}

.panel-stack__spine:hover {
  background: var(--surface-hover);
}

.panel-stack__spine:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.panel-stack__spine-text {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  font-size: var(--type-small);
  line-height: 20px;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: start;
  writing-mode: vertical-rl;
}

.panel-stack__spine-kind {
  color: var(--text-tertiary);
}

.panel-stack__spine-count {
  font-size: var(--type-caption);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

/* Focus mode (⌘⇧F): the top sheet's content sits in a centred reading column. */
.panel-stack[data-focus-mode] .panel-stack__item[data-mode="full"] {
  justify-content: center;
}
`;

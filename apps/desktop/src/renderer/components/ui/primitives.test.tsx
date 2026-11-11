import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "./command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "./context-menu";
import { Dialog, DialogContent, DialogTrigger } from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "./dropdown-menu";
import { EmptyState } from "./empty-state";
import { ErrorState } from "./error-state";
import { HoverCard, HoverCardContent, HoverCardTrigger, hoverCardOpenDelayMs } from "./hover-card";
import { Kbd } from "./kbd";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { ScrollArea } from "./scroll-area";
import { Sheet, SheetContent } from "./sheet";
import { LoadingState, Skeleton, SkeletonLines } from "./skeleton";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";
import { Tooltip } from "./tooltip";

const t = createTranslator("en");
const noop = () => undefined;

// Floating content renders in a portal only in the browser, so these tests render it in place
// (`portal={false}`) with a controlled `open`, and read roles and ARIA attributes from the markup.

describe("dialog", () => {
  it("is a modal dialog named by its title, with a labelled close control", () => {
    const html = renderToStaticMarkup(
      <Dialog open onOpenChange={noop}>
        <DialogContent
          t={t}
          title="Remove this note?"
          description="It can be restored."
          portal={false}
        >
          <p>Body</p>
        </DialogContent>
      </Dialog>
    );
    expect(html).toContain('role="dialog"');
    // Radix links the dialog to its title and description in an effect, so the markup holds the
    // two elements (the title is the heading) and the browser adds the references.
    expect(html).toMatch(/<h2 id="[^"]+"[^>]*>Remove this note\?<\/h2>/u);
    expect(html).toMatch(/<p id="[^"]+"[^>]*>It can be restored\.<\/p>/u);
    expect(html).toContain("Remove this note?");
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("var(--scrim)");
  });

  it("names itself without a heading when the title is hidden and has no description", () => {
    const html = renderToStaticMarkup(
      <Dialog open onOpenChange={noop}>
        <DialogContent t={t} title="Palette" hideTitle showClose={false} portal={false} />
      </Dialog>
    );
    expect(html).toContain('class="sr-only"');
    expect(html).not.toContain("aria-describedby=");
    expect(html).not.toContain('aria-label="Close"');
  });

  it("marks its trigger as opening a dialog", () => {
    const html = renderToStaticMarkup(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
      </Dialog>
    );
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
  });
});

describe("sheet", () => {
  it("is a non-modal dialog: no scrim, no inert siblings, named by its title", () => {
    const html = renderToStaticMarkup(
      <Sheet open onOpenChange={noop}>
        <SheetContent title="Lactic fermentation" portal={false}>
          <p>Peeking</p>
        </SheetContent>
      </Sheet>
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Lactic fermentation");
    expect(html).not.toContain("--scrim");
    expect(html).not.toContain("data-aria-hidden");
    expect(html).not.toContain('aria-label="Close"');
  });

  // renderToStaticMarkup runs no effects, so a modal root renders the same markup as a non-modal
  // one: the behaviour is asserted on the props the wrappers hand to Radix.
  it("opens its Radix root with modal=false", () => {
    const root = Sheet({ open: true, onOpenChange: noop }) as ReactElement<{ modal?: boolean }>;
    expect(isValidElement(root)).toBe(true);
    expect(root.props.modal).toBe(false);
  });

  it("stays open when focus moves to another row, and still tells the caller", () => {
    type Props = { onFocusOutside: (event: { preventDefault(): void }) => void };
    const seen: string[] = [];
    const content = SheetContent({
      title: "Lactic fermentation",
      portal: false,
      onFocusOutside: () => seen.push("caller")
    }) as ReactElement<Props>;
    const event = { preventDefault: () => seen.push("prevented") };
    content.props.onFocusOutside(event);
    expect(seen).toEqual(["prevented", "caller"]);
  });

  it("keeps focus on the row at open and close", () => {
    type Props = { onOpenAutoFocus: (e: Event) => void; onCloseAutoFocus: (e: Event) => void };
    const content = SheetContent({ title: "x", portal: false }) as ReactElement<Props>;
    for (const handler of [content.props.onOpenAutoFocus, content.props.onCloseAutoFocus]) {
      const event = new Event("focus", { cancelable: true });
      handler(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });
});

describe("popover, hover card and tooltip", () => {
  it("renders a popover as a dialog opened by a trigger", () => {
    const html = renderToStaticMarkup(
      <Popover open>
        <PopoverTrigger>Filters</PopoverTrigger>
        <PopoverContent portal={false}>Content</PopoverContent>
      </Popover>
    );
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="dialog"');
  });

  it("opens a hover card after 300 ms and puts the card in the raised pop surface", () => {
    expect(hoverCardOpenDelayMs).toBe(300);
    const html = renderToStaticMarkup(
      <HoverCard open>
        <HoverCardTrigger asChild>
          <a href="#note">A note</a>
        </HoverCardTrigger>
        <HoverCardContent portal={false}>Preview</HoverCardContent>
      </HoverCard>
    );
    expect(html).toContain('data-state="open"');
    expect(html).toContain("Preview");
    expect(html).toContain("var(--shadow-pop)");
  });

  it("shows a tooltip as role tooltip and keeps the trigger's own name", () => {
    const html = renderToStaticMarkup(
      <Tooltip label="Search the library" shortcut="⌘K" open portal={false}>
        <button type="button" aria-label="Search">
          S
        </button>
      </Tooltip>
    );
    expect(html).toContain('role="tooltip"');
    expect(html).toContain("Search the library");
    expect(html).toContain("⌘K");
    expect(html).toContain('aria-label="Search"');
    expect(html).toContain("aria-describedby=");
  });
});

describe("menus", () => {
  it("renders a dropdown menu as role menu with menuitems and a labelled trigger", () => {
    const html = renderToStaticMarkup(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Add</DropdownMenuTrigger>
        <DropdownMenuContent portal={false}>
          <DropdownMenuItem shortcut="⌘N" description="A page">
            Add a link
          </DropdownMenuItem>
          <DropdownMenuItem disabled>Add a file</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('role="menu"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(2);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("⌘N");
  });

  it("renders a context menu with the same items", () => {
    const html = renderToStaticMarkup(
      <ContextMenu>
        <ContextMenuTrigger>Row</ContextMenuTrigger>
        <ContextMenuContent portal={false}>
          <ContextMenuItem>Open beside</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
    // Closed until a right click: the trigger renders and the menu is absent.
    expect(html).toContain('data-state="closed"');
    expect(html).not.toContain('role="menuitem"');
  });
});

describe("command", () => {
  it("renders a combobox input, a listbox and options on cmdk's own semantics", () => {
    const html = renderToStaticMarkup(
      <Command shouldFilter={false} label="Palette">
        <CommandInput placeholder="Search" />
        <CommandList>
          <CommandGroup heading="Notes">
            <CommandItem value="a">Lactic fermentation</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html).toContain('role="presentation"');
    expect(html).toContain("Notes");
  });
});

describe("toggle group", () => {
  it("is a named group of pressed buttons that Radix gives one roving tab stop", () => {
    const html = renderToStaticMarkup(
      <ToggleGroup label="Density" value="comfortable" onValueChange={noop}>
        <ToggleGroupItem value="comfortable">Comfortable</ToggleGroupItem>
        <ToggleGroupItem value="compact">Compact</ToggleGroupItem>
      </ToggleGroup>
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Density"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(1);
    expect(html.match(/data-radix-collection-item/g)).toHaveLength(2);
  });
});

describe("the four-state building blocks", () => {
  it("loading is a busy status region with a spoken label and no spinner, bars only after the delay", () => {
    const html = renderToStaticMarkup(
      <LoadingState t={t}>
        <SkeletonLines lines={2} />
      </LoadingState>
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading");
    // The first render is inside the 150 ms window: no bars yet.
    expect(html).not.toContain("ui-shimmer");

    const immediate = renderToStaticMarkup(
      <LoadingState t={t} delayMs={0}>
        <SkeletonLines lines={2} />
      </LoadingState>
    );
    expect(immediate.match(/ui-shimmer/g)).toHaveLength(2);
    expect(immediate).toContain('aria-hidden="true"');
  });

  it("empty is a dashed strong outline with the teaching copy and the action, never busy or alert", () => {
    const html = renderToStaticMarkup(
      <EmptyState headline="No notes yet" action={<button type="button">Add a source</button>}>
        Add a source and its notes appear here.
      </EmptyState>
    );
    expect(html).toContain("border-dashed");
    expect(html).toContain("border-border-strong");
    expect(html).toContain("Add a source and its notes appear here.");
    expect(html).toContain("Add a source");
    expect(html).not.toContain("aria-busy");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("ui-shimmer");
  });

  it("error is an alert in place with the message, what is kept, Retry and Details", () => {
    const html = renderToStaticMarkup(
      <ErrorState
        t={t}
        message="The library did not load."
        kept="Nothing was lost."
        onRetry={noop}
        details="ECONNRESET"
      />
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("The library did not load.");
    expect(html).toContain("Nothing was lost.");
    expect(html).toContain(">Retry<");
    expect(html).toContain(">Details<");
    expect(html).toContain('aria-expanded="false"');
    // The technical text stays folded until asked for.
    expect(html).not.toContain("ECONNRESET");
  });

  it("error without a retry or details shows the sentence alone", () => {
    const html = renderToStaticMarkup(<ErrorState t={t} message="It failed." />);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("<button");
  });

  it("speaks the fixed copy in every locale", () => {
    const pt = createTranslator("pt-BR");
    const html = renderToStaticMarkup(
      <ErrorState t={pt} message="Falhou." onRetry={noop} details="x" />
    );
    expect(html).toContain("Tentar de novo");
    expect(html).toContain("Detalhes");
  });
});

describe("small primitives", () => {
  it("draws a keycap on the tokens, outlined on solid", () => {
    expect(renderToStaticMarkup(<Kbd>⌘K</Kbd>)).toContain("border-b-border-strong");
    expect(renderToStaticMarkup(<Kbd tone="on-solid">⌘N</Kbd>)).toContain(
      "border-accent-foreground"
    );
  });

  it("hides a skeleton bar from assistive technology", () => {
    expect(renderToStaticMarkup(<Skeleton />)).toContain('aria-hidden="true"');
  });

  it("renders a scroll area with a viewport that holds the content", () => {
    const html = renderToStaticMarkup(
      <ScrollArea className="h-10">
        <p>Row</p>
      </ScrollArea>
    );
    expect(html).toContain("data-radix-scroll-area-viewport");
    expect(html).toContain("Row");
  });
});

describe("tokens only", () => {
  const sources = import.meta.glob<string>("./*.tsx", {
    query: "?raw",
    import: "default",
    eager: true
  });
  const primitives = Object.entries(sources).filter(
    ([path]) =>
      !path.endsWith(".test.tsx") &&
      !path.endsWith(".screen.tsx") &&
      !/\/(button|input|label|switch|tabs|toast|tag-input|cover-image)\.tsx$/u.test(path)
  );

  it("finds the new primitives", () => {
    expect(primitives.length).toBeGreaterThanOrEqual(14);
  });

  it("use no raw palette class, no hex colour and no arbitrary font size", () => {
    for (const [path, source] of primitives) {
      expect(source, path).not.toMatch(
        /(?:text|bg|border|ring|fill|stroke)-(?:slate|cyan|gray|rose|emerald)-\d/u
      );
      expect(source, path).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
      expect(source, path).not.toMatch(/text-\[[0-9.]+(?:px|rem)\]/u);
      expect(source, path).not.toMatch(/\bsetInterval\b/u);
    }
  });

  it("keep every line under 200 characters (the quality ratchet counts longer ones)", () => {
    for (const [path, source] of primitives)
      for (const line of source.split("\n"))
        expect(line.length, `${path}: ${line.slice(0, 40)}`).toBeLessThanOrEqual(200);
  });

  it("bind no global shortcut of their own (no Cmd-W, no key handlers on the window)", () => {
    for (const [path, source] of primitives) {
      expect(source, path).not.toMatch(/addEventListener\(["']keydown/u);
      expect(source, path).not.toMatch(/metaKey|ctrlKey/u);
    }
  });
});

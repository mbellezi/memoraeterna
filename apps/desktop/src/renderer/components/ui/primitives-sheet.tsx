import { useCallback, useEffect, useState, type ReactNode } from "react";
import { FileText, FolderPlus, Link2, PanelRight, Search } from "lucide-react";
import type { Translator } from "@app/i18n";
import { Button } from "./button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut
} from "./command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "./context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "./dropdown-menu";
import { EmptyState } from "./empty-state";
import { ErrorState } from "./error-state";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card";
import { Kbd } from "./kbd";
import { LoadingState, SkeletonRows } from "./skeleton";
import { ScrollArea } from "./scroll-area";
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader } from "./sheet";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";
import { Tooltip } from "./tooltip";

/**
 * The primitives sheet: every first-party primitive of `components/ui` on the tokens, in one place,
 * for the screens tool and for anyone choosing a control. It is a developer reference, not product
 * UI: nothing imports it except its screen module, so its labels are not product copy and it is
 * not part of the shipped bundle. The "States" block is live: it loads a short sample list and
 * shows the loading, empty, error or success state that load is in, which is what the frame reports.
 */
export interface PrimitiveSample {
  id: string;
  title: string;
  meta: string;
}

type SampleState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: readonly PrimitiveSample[] };

function useSamples(load: () => Promise<readonly PrimitiveSample[]>) {
  const [state, setState] = useState<SampleState>({ status: "loading" });
  const fetchRows = useCallback(() => {
    load().then(
      (rows) => setState({ status: "ready", rows }),
      (error: unknown) =>
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error)
        })
    );
  }, [load]);
  useEffect(() => {
    fetchRows();
  }, [fetchRows]);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    fetchRows();
  }, [fetchRows]);
  return { state, retry };
}

const frameState = (state: SampleState): string =>
  state.status === "ready" ? (state.rows.length === 0 ? "empty" : "success") : state.status;

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3 rounded-lg border border-border bg-surface p-4 shadow-[var(--shadow-sheet)]">
      <h2 className="m-0 text-xs font-semibold text-secondary-foreground">{title}</h2>
      {children}
    </section>
  );
}

function ControlsBlock() {
  const [density, setDensity] = useState("comfortable");
  return (
    <Block title="Buttons, keys and the segmented control">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary">
          Add <Kbd tone="on-solid">⌘N</Kbd>
        </Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Quiet</Button>
        <Button variant="link">Link</Button>
        <Tooltip label="Search the library" shortcut="⌘K" side="top">
          <Button variant="ghost" aria-label="Search the library">
            <Search aria-hidden="true" />
          </Button>
        </Tooltip>
        {/* Held open, so a capture shows the tooltip itself: label, shortcut, side. */}
        <Tooltip label="Open beside" shortcut="⌥↵" side="right" open portal={false}>
          <Button variant="ghost" aria-label="Open beside">
            <PanelRight aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
      <ToggleGroup label="Density" value={density} onValueChange={setDensity}>
        <ToggleGroupItem value="comfortable">Comfortable</ToggleGroupItem>
        <ToggleGroupItem value="compact">Compact</ToggleGroupItem>
      </ToggleGroup>
      <p className="m-0 flex flex-wrap items-center gap-1 text-sm text-secondary-foreground">
        <Kbd>Esc</Kbd> close · <Kbd>↵</Kbd> open · <Kbd>⌥↵</Kbd> open here · <Kbd>Space</Kbd> peek
      </p>
    </Block>
  );
}

function MenusBlock() {
  return (
    <Block title="Menu and context menu">
      <div className="flex flex-wrap items-start gap-3">
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary">Add</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent portal={false} align="start" side="bottom" className="w-56">
            <DropdownMenuItem icon={<FileText />} shortcut="⌘N">
              Add a file
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Link2 />} description="A web page or an article">
              Add a link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<FolderPlus />}>More ways to add…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ContextMenu>
          <ContextMenuTrigger className="rounded-md border border-dashed border-border-strong px-3 py-2 text-sm text-secondary-foreground">
            Right-click a row
          </ContextMenuTrigger>
          <ContextMenuContent portal={false}>
            <ContextMenuItem>Open beside</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
      <div className="h-48" aria-hidden="true" />
    </Block>
  );
}

function HoverCardBlock() {
  return (
    <Block title="Hover card">
      <HoverCard open>
        <HoverCardTrigger asChild>
          <a href="#primitives" className="text-sm text-accent underline underline-offset-2">
            Hover or focus this link
          </a>
        </HoverCardTrigger>
        <HoverCardContent portal={false} side="bottom" className="w-72">
          <p className="m-0 text-xs text-muted-foreground">Note</p>
          <p className="m-0 font-reading text-base font-semibold">Lactic fermentation</p>
          <p className="m-0 text-sm text-secondary-foreground">
            Opens after 300 ms, closes with Esc.
          </p>
        </HoverCardContent>
      </HoverCard>
      <div className="h-24" aria-hidden="true" />
    </Block>
  );
}

function PaletteBlock() {
  return (
    <Block title="Command (Cmd-K)">
      <div className="overflow-hidden rounded-xl border border-border-strong">
        <Command shouldFilter={false} label="Command palette" value="Lactic fermentation">
          <CommandInput placeholder="Search or type a command" />
          <CommandList>
            <CommandGroup heading="Best match">
              <CommandItem value="Lactic fermentation">
                <FileText aria-hidden="true" /> Lactic fermentation
                <CommandShortcut>Note</CommandShortcut>
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="Do">
              <CommandItem value="Go to the Map">
                Go to the Map <CommandShortcut>⌘5</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </div>
    </Block>
  );
}

function QuickLookBlock() {
  return (
    <Block title="Sheet (quick-look, not modal)">
      <Sheet open>
        <SheetContent
          title="Lactic fermentation"
          portal={false}
          lift
          className="static! mx-auto max-w-full! translate-x-0!"
        >
          <SheetHeader className="flex-wrap gap-x-4 gap-y-1">
            <span>Peeking</span>
            <span>
              <Kbd>Space</Kbd> closes
            </span>
            <span>
              <Kbd>↵</Kbd> opens beside
            </span>
            <span>
              <Kbd>↑↓</Kbd> peek the next
            </span>
            <span>
              <Kbd>⌥↵</Kbd> open in this panel
            </span>
          </SheetHeader>
          <SheetBody>
            <p className="m-0 text-xs text-muted-foreground">Note · 3 min</p>
            <p className="m-0 font-reading text-xl font-semibold">Lactic fermentation</p>
            <p className="m-0 font-reading text-reading text-secondary-foreground">
              Bacteria turn sugars into acid, which keeps the food for months.
            </p>
            <p className="m-0 text-xs text-muted-foreground">2 connections · 1 source</p>
          </SheetBody>
          <SheetFooter>
            <span>
              <Kbd>Esc</Kbd> close
            </span>
            <span className="text-muted-foreground">The list stays here; nothing was opened.</span>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </Block>
  );
}

function StatesBlock({
  t,
  state,
  retry
}: {
  t: Translator;
  state: SampleState;
  retry: () => void;
}) {
  return (
    <Block title="States: loading, empty, error, success">
      {state.status === "loading" ? (
        <LoadingState t={t}>
          <SkeletonRows rows={5} className="h-40" />
        </LoadingState>
      ) : state.status === "error" ? (
        <ErrorState
          t={t}
          message="The samples did not load."
          kept="Nothing was changed."
          onRetry={retry}
          details={state.message}
        />
      ) : state.rows.length === 0 ? (
        <EmptyState
          headline="No samples yet"
          action={<Button variant="primary">Add a sample</Button>}
        >
          A sample appears here as soon as one exists. Add the first one to see the list.
        </EmptyState>
      ) : (
        <ScrollArea className="h-40">
          <ul className="m-0 grid list-none gap-1 p-0">
            {state.rows.map((row) => (
              <li
                key={row.id}
                className="flex items-baseline gap-3 rounded-md px-2 py-1 text-sm hover:bg-surface-hover"
              >
                <span className="min-w-0 flex-1 font-medium">{row.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{row.meta}</span>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </Block>
  );
}

/** The sheet. `load` answers the sample list of the States block (the screen module's fake `window.app`). */
export function PrimitivesSheet({
  t,
  load
}: {
  t: Translator;
  load: () => Promise<readonly PrimitiveSample[]>;
}) {
  const { state, retry } = useSamples(load);
  return (
    <div
      data-surface="primitives"
      data-state={frameState(state)}
      className="grid min-w-0 gap-4 bg-background p-6 text-foreground"
    >
      <h1 className="m-0 font-reading text-2xl font-semibold">Primitives</h1>
      <div className="grid min-w-0 grid-cols-2 gap-4">
        <div className="grid min-w-0 content-start gap-4">
          <ControlsBlock />
          <StatesBlock t={t} state={state} retry={retry} />
          <PaletteBlock />
        </div>
        <div className="grid min-w-0 content-start gap-4">
          <MenusBlock />
          <HoverCardBlock />
          <QuickLookBlock />
        </div>
      </div>
    </div>
  );
}

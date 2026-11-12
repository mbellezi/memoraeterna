import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "../../lib/stable-callback";

/** What the window knows of a drag in flight: that it carries files, and how many (names are hidden until the drop). */
export interface WindowDrag {
  active: boolean;
  count: number;
}

const idle: WindowDrag = { active: false, count: 0 };

/** A drag that carries files from outside the page (text and links being dragged are not ours). */
export function dragCarriesFiles(transfer: Pick<DataTransfer, "types"> | null): boolean {
  return transfer !== null && Array.from(transfer.types).includes("Files");
}

/** How many files a drag carries; the browser hides their names until the drop. */
export function dragFileCount(transfer: Pick<DataTransfer, "items"> | null): number {
  if (!transfer) return 0;
  return Array.from(transfer.items).filter((item) => item.kind === "file").length;
}

/**
 * Files dragged over the window (F5 D32). The window always takes a file drag, so Electron never
 * navigates to a dropped file; while it is enabled, `onFiles` gets the dropped `File` objects and
 * the returned state says a drag is over the window. Only files are handled: a dragged selection or
 * link passes through untouched. No timer: the counters follow `dragenter` and `dragleave`.
 */
export function useWindowDrop(onFiles: (files: File[]) => void, enabled = true): WindowDrag {
  const [drag, setDrag] = useState<WindowDrag>(idle);
  const depth = useRef(0);
  const takeFiles = useStableCallback(onFiles);
  const allowed = useRef(enabled);
  useEffect(() => {
    allowed.current = enabled;
  }, [enabled]);

  useEffect(() => {
    const reset = () => {
      depth.current = 0;
      setDrag(idle);
    };
    const onEnter = (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current += 1;
      if (allowed.current) setDrag({ active: true, count: dragFileCount(event.dataTransfer) });
    };
    const onOver = (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDrag(idle);
    };
    const onDrop = (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      reset();
      if (allowed.current && files.length > 0) takeFiles(files);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", reset);
    };
  }, [takeFiles]);

  return drag;
}

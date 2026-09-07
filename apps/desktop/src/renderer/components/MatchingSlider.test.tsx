import type { ReactElement, InputHTMLAttributes, ButtonHTMLAttributes } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatchingSlider } from "./MatchingSlider";

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (value: number) => [value, vi.fn()],
  useRef: (value: boolean) => ({ current: value }),
  useEffect: vi.fn()
}));

describe("MatchingSlider commits", () => {
  const onCommit = vi.fn();
  beforeEach(() => onCommit.mockClear());

  function controls() {
    const tree = MatchingSlider({ id: "threshold", label: "Threshold", value: 0.8, defaultValue: 0.7, resetLabel: "Restore", onCommit });
    const children = tree.props.children as ReactElement[];
    const input = children[1]!.props as InputHTMLAttributes<HTMLInputElement>;
    const header = children[0]!.props as { children: ReactElement[] };
    const reset = header.children[1]!.props as ButtonHTMLAttributes<HTMLButtonElement>;
    return { input, reset };
  }

  it("does not save while dragging and saves once on release, including outside the slider", () => {
    const { input } = controls();
    const capture = vi.fn();
    input.onPointerDown!({ pointerId: 1, currentTarget: { setPointerCapture: capture } } as never);
    expect(capture).toHaveBeenCalledWith(1);
    input.onChange!({ currentTarget: { value: "0.85" } } as never);
    input.onChange!({ currentTarget: { value: "0.9" } } as never);
    expect(onCommit).not.toHaveBeenCalled();
    input.onPointerUp!({ currentTarget: { value: "0.9" } } as never);
    input.onBlur!({ currentTarget: { value: "0.9" } } as never);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(0.9);
  });

  it("discards canceled gestures", () => {
    const { input } = controls();
    input.onChange!({ currentTarget: { value: "0.9" } } as never);
    input.onPointerCancel!({} as never);
    input.onBlur!({ currentTarget: { value: "0.9" } } as never);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("saves keyboard adjustments on key release and restores the default independently", () => {
    const { input, reset } = controls();
    input.onChange!({ currentTarget: { value: "0.81" } } as never);
    expect(onCommit).not.toHaveBeenCalled();
    input.onKeyUp!({ key: "ArrowRight", currentTarget: { value: "0.81" } } as never);
    expect(onCommit).toHaveBeenLastCalledWith(0.81);
    reset.onClick!({} as never);
    expect(onCommit).toHaveBeenLastCalledWith(0.7);
  });
});

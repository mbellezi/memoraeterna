import type { AiBudgetClass, AiPriority, AiWorkloadClass, LaneAdmission, LaneKey } from "@app/ai";
import {
  BackgroundBlockedError,
  defaultKnowledgeControls,
  gardenerBlocker,
  gardenerKindPolicies,
  type KnowledgeControls
} from "@app/domain";
import { describe, expect, it } from "vitest";

import { BackgroundGate, controlGateReasons, type KindGate } from "./background-gate.js";
import type { PowerSnapshot } from "./power-signals.js";

const idleOnAc: PowerSnapshot = {
  active: false,
  onBattery: false,
  idleMs: 3_600_000,
  overridden: false
};
const activeOnBattery: PowerSnapshot = {
  active: true,
  onBattery: true,
  idleMs: 5_000,
  overridden: false
};

function gate(
  controls: Partial<KnowledgeControls> = {},
  power: PowerSnapshot = idleOnAc,
  extra: { kindGates?: KindGate[]; now?: () => number } = {}
) {
  const state = { controls: { ...defaultKnowledgeControls, ...controls }, power };
  const instance = new BackgroundGate({
    controls: () => state.controls,
    power: () => state.power,
    dutyCycle: () => (state.power.active ? 0.5 : 1),
    ...extra
  });
  return { state, gate: instance };
}

const call = (
  budgetClass: AiBudgetClass | undefined,
  workloadClass: AiWorkloadClass,
  lane: LaneKey = "local",
  priority: AiPriority = "P3",
  jobId?: string
): LaneAdmission => ({
  lane,
  priority,
  workloadClass,
  budgetClass,
  label: "call",
  jobId
});

const allKinds = Object.keys(gardenerKindPolicies);

describe("background gate at claim (D7)", () => {
  it("holds nothing with the default controls", () => {
    expect(gate().gate.forKinds(allKinds).size).toBe(0);
  });

  it("holds every background Gardener kind while paused, never ingestion or the mixed link kinds", () => {
    const held = gate({ paused: true }).gate.forKinds([...allKinds, "ingestion", "obsidian-wiki"]);
    expect([...held.keys()].sort()).toEqual(
      allKinds.filter((type) => gardenerKindPolicies[type]!.budget === "background").sort()
    );
    expect(held.get("topic-place")).toEqual({ class: "paused", reason: "user_pause" });
    expect(held.has("ingestion")).toBe(false);
    expect(held.has("relation-link")).toBe(false);
  });

  it("holds the generative kinds under Off and still places (Off still places)", () => {
    const held = gate({ autonomy: "off" }).gate.forKinds(allKinds);
    expect([...held.keys()].sort()).toEqual([
      "catalog-header",
      "relation-explain-backfill",
      "relation-retype",
      "topic-areas",
      "topic-overview"
    ]);
    for (const blocker of held.values())
      expect(blocker).toEqual(gardenerBlocker("paused", "autonomy_off"));
    expect(gate({ autonomy: "off" }).gate.heldKinds(["topic-place", "topic-gate"]).size).toBe(0);
    // Naming runs under Off and names provisionally: its model call is refused at admission.
    const off = gate({ autonomy: "off" }).gate;
    expect(off.heldKinds(["topic-name"]).size).toBe(0);
    expect(
      off.admission({
        lane: "remote:codex",
        priority: "P3",
        workloadClass: "write-fast",
        budgetClass: "background",
        label: "topic_naming"
      })
    ).toEqual(gardenerBlocker("paused", "autonomy_off"));
  });

  it("holds Gardener kinds while the user is active under only-idle, and on battery under only-AC", () => {
    const active: PowerSnapshot = { ...idleOnAc, idleMs: 120_000 };
    expect(
      gate({ onlyIdle: true }, active).gate.forKinds(["topic-place"]).get("topic-place")
    ).toEqual({
      class: "paused",
      reason: "only_idle_user_active"
    });
    // Idle for 5 minutes lets them run.
    expect(
      gate({ onlyIdle: true }, { ...idleOnAc, idleMs: 300_000 }).gate.heldKinds(["topic-place"])
        .size
    ).toBe(0);
    expect(
      gate({ onlyOnAc: true }, { ...idleOnAc, onBattery: true })
        .gate.forKinds(["topic-name"])
        .get("topic-name")
    ).toEqual({ class: "paused", reason: "only_ac_on_battery" });
    expect(gate({ onlyOnAc: true }, idleOnAc).gate.heldKinds(["topic-name"]).size).toBe(0);
  });

  it("names the highest blocker when several hold a kind (precedence)", () => {
    const { gate: instance } = gate(
      { paused: true, autonomy: "off", onlyIdle: true, onlyOnAc: true },
      activeOnBattery,
      {
        kindGates: [
          {
            reasons: ["cap.money_100"],
            blocker: (type) => (type === "topic-name" ? gardenerBlocker("cap", "money_100") : null)
          }
        ]
      }
    );
    expect(instance.forKinds(["topic-name"]).get("topic-name")).toEqual({
      class: "paused",
      reason: "user_pause"
    });
    const notPaused = gate({ autonomy: "off", onlyOnAc: true }, activeOnBattery).gate;
    expect(notPaused.forKinds(["topic-overview"]).get("topic-overview")?.reason).toBe(
      "autonomy_off"
    );
    expect(notPaused.forKinds(["topic-place"]).get("topic-place")?.reason).toBe(
      "only_ac_on_battery"
    );
  });

  it("adds the gates other services own, by kind, and lists their reasons for clearing", () => {
    const kindGate: KindGate = {
      reasons: ["no_model.no_route"],
      blocker: (_type, policy) =>
        policy.ai === "generative"
          ? gardenerBlocker("no_model", "no_route", { params: { routeClass: "write-fast" } })
          : null
    };
    const { gate: instance } = gate({}, idleOnAc, { kindGates: [kindGate] });
    expect(instance.forKinds(["topic-name", "topic-place"])).toEqual(
      new Map([
        [
          "topic-name",
          { class: "no_model", reason: "no_route", params: { routeClass: "write-fast" } }
        ]
      ])
    );
    expect(instance.evaluatedReasons()).toEqual([...controlGateReasons, "no_model.no_route"]);
    expect([...instance.activeReasons(allKinds)]).toEqual(["no_model.no_route"]);
  });

  it("reports the reasons that hold anything now", () => {
    expect([...gate().gate.activeReasons(allKinds)]).toEqual([]);
    expect(
      [
        ...gate(
          { paused: true, autonomy: "off", onlyOnAc: true },
          activeOnBattery
        ).gate.activeReasons(allKinds)
      ].sort()
    ).toEqual(["paused.autonomy_off", "paused.only_ac_on_battery", "paused.user_pause"]);
  });
});

describe("background gate at admission (D7, D15)", () => {
  it("never refuses user or interactive calls, a P2 import included, whatever the controls", () => {
    const { gate: instance } = gate(
      { paused: true, autonomy: "off", onlyIdle: true, onlyOnAc: true },
      activeOnBattery
    );
    for (const budgetClass of ["user", "interactive", undefined] as const)
      for (const priority of ["P0", "P1", "P2", "P3"] as const)
        expect(
          instance.admission(call(budgetClass, "write-fast", "remote:codex", priority))
        ).toBeNull();
  });

  it("refuses background calls while paused, only-idle with the user active, or only-AC on battery", () => {
    expect(gate({ paused: true }).gate.admission(call("background", "embed"))?.reason).toBe(
      "user_pause"
    );
    expect(
      gate({ onlyIdle: true }, activeOnBattery).gate.admission(call("background", "decide"))?.reason
    ).toBe("only_idle_user_active");
    expect(
      gate({ onlyOnAc: true }, activeOnBattery).gate.admission(call("background", "decide"))?.reason
    ).toBe("only_ac_on_battery");
    expect(gate().gate.admission(call("background", "write-quality", "remote:codex"))).toBeNull();
  });

  it("refuses generative and remote background calls under Off, and lets local deciding and embedding run", () => {
    const { gate: instance } = gate({ autonomy: "off" });
    expect(instance.admission(call("background", "write-fast"))?.reason).toBe("autonomy_off");
    expect(instance.admission(call("background", "embed", "remote:openai"))?.reason).toBe(
      "autonomy_off"
    );
    expect(instance.admission(call("background", "decide"))).toBeNull();
    expect(instance.admission(call("background", "embed"))).toBeNull();
  });

  it("refuses with a BackgroundBlockedError and keeps the refusal for its job, once", () => {
    let now = 0;
    const { gate: instance, state } = gate({ paused: true }, idleOnAc, { now: () => now });
    const refusal = instance.admit(call("background", "write-fast", "local", "P3", "job-1"));
    expect(refusal).toBeInstanceOf(BackgroundBlockedError);
    expect(refusal?.blocker).toEqual({ class: "paused", reason: "user_pause" });
    expect(instance.takeAdmissionBlock("job-1")).toEqual({ class: "paused", reason: "user_pause" });
    expect(instance.takeAdmissionBlock("job-1")).toBeUndefined();
    // The highest blocker a job's calls met is kept.
    state.controls = { ...state.controls, paused: false, autonomy: "off", onlyOnAc: true };
    state.power = activeOnBattery;
    instance.admit(call("background", "write-fast", "local", "P3", "job-2"));
    expect(instance.takeAdmissionBlock("job-2")?.reason).toBe("autonomy_off");
    // A refusal no job collects is forgotten after its time to live.
    instance.admit(call("background", "write-fast", "local", "P3", "job-3"));
    now += 3_600_001;
    instance.admit(call("background", "write-fast", "local", "P3", "job-4"));
    expect(instance.takeAdmissionBlock("job-3")).toBeUndefined();
    expect(instance.takeAdmissionBlock("job-4")).toBeDefined();
    expect(instance.admit(call("user", "write-fast", "local", "P2", "job-5"))).toBeUndefined();
    expect(instance.takeAdmissionBlock("job-5")).toBeUndefined();
    // A refusal met outside the scheduler (the RemoteBudget's) is kept for its job too, and the
    // highest blocker still wins.
    instance.noteRefusal("job-6", { class: "cap", reason: "money_80" });
    expect(instance.takeAdmissionBlock("job-6")).toEqual({ class: "cap", reason: "money_80" });
  });

  it("gives the duty cycle of the power signals", () => {
    expect(gate({}, activeOnBattery).gate.dutyCycle()).toBe(0.5);
    expect(gate({}, idleOnAc).gate.dutyCycle()).toBe(1);
  });
});

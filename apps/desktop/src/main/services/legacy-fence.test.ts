import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IpcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRecord, PgPool } from "@app/db";
import {
  CuratorCommandSchema,
  MaintenanceCommandSchema,
  OrganizationCommandSchema,
  WikiCollectionCommandSchema
} from "@app/domain";
import { messages } from "@app/i18n";
import { ipcChannels } from "../../shared/ipc.js";
import { JobSupervisor } from "./job-supervisor.js";
import {
  createMaintenanceCommandHandler,
  createRetiredJobExecutor,
  fenceLegacyCommand,
  legacyRetiredKey,
  maintenanceReadCommands
} from "./legacy-fence.js";
import {
  curatorReadCommands,
  organizationReadCommands,
  registerOrganizationIpc,
  wikiCollectionReadCommands
} from "./organization-ipc.js";
import { registerWikiIpc } from "./wiki-ipc.js";
import type { MaintenanceService } from "./maintenance-service.js";
import type { OrganizationService } from "./organization-service.js";
import type { WikiService } from "./wiki-service.js";

const mocks = vi.hoisted(() => ({
  jobs: {
    recoverInterrupted: vi.fn(),
    findById: vi.fn(),
    requestCancel: vi.fn(),
    claimNext: vi.fn(),
    nextQueuedOfType: vi.fn(),
    update: vi.fn()
  },
  // Only the cancel of a run exists here: any other call into the legacy repositories (a save, an
  // insert, an admission) is a TypeError, so the tests below prove the fence writes nothing else.
  organization: { cancel: vi.fn() },
  maintenance: { cancel: vi.fn() },
  hierarchy: { refreshBatch: vi.fn() }
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createJobRepository: () => mocks.jobs,
  createOrganizationRepository: () => mocks.organization,
  createMaintenanceRepository: () => mocks.maintenance,
  createHierarchicalIngestionRepository: () => mocks.hierarchy
}));

/** The command names a schema accepts, flattening nested unions. */
function commandNames(schema: unknown): string[] {
  const options = (schema as { options?: unknown[] }).options;
  if (options) return options.flatMap(commandNames);
  const literal = (schema as { shape: { command: { value: string } } }).shape.command;
  return [literal.value];
}

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>();
  return {
    ipc: {
      handle: (channel: string, handler: (event: unknown, input?: unknown) => unknown) => {
        handlers.set(channel, handler);
      }
    } as unknown as IpcMain,
    call: async (channel: string, input?: unknown) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return handler({}, input);
    },
    channels: () => [...handlers.keys()]
  };
}

describe("fenceLegacyCommand", () => {
  const schema = {
    parse: (input: unknown) => input as { command: string; id?: string }
  };

  it("runs an allow-listed command and retires everything else before the service", () => {
    const run = vi.fn((command: { command: string }) => command.command);
    const fenced = fenceLegacyCommand(new Set(["read"]), schema, run);
    expect(fenced({ command: "read", id: "1" })).toBe("read");
    expect(run).toHaveBeenCalledOnce();
    for (const input of [{ command: "write" }, {}, null, "read", 42, { command: 7 }])
      expect(() => fenced(input)).toThrow(legacyRetiredKey);
    expect(run).toHaveBeenCalledOnce();
  });

  it("validates an allowed command and lets the validation error through", () => {
    const strict = fenceLegacyCommand(
      new Set(["read"]),
      {
        parse: (input: unknown) => {
          if (!(input as { id?: string }).id) throw new Error("invalid");
          return input as { command: string };
        }
      },
      () => "ran"
    );
    expect(() => strict({ command: "read" })).toThrow("invalid");
  });

  it("names a localized message in every language", () => {
    for (const locale of Object.values(messages)) expect(locale.legacy.errors.retired).toBeTruthy();
    expect(legacyRetiredKey).toBe("legacy.errors.retired");
  });
});

describe("legacy organization, curator and collection channels", () => {
  function setup() {
    const service = {
      command: vi.fn(async () => "organization"),
      automaticCommand: vi.fn(async () => "curator"),
      collectionCommand: vi.fn(async () => "collection")
    };
    const host = fakeIpc();
    registerOrganizationIpc(host.ipc, service as unknown as OrganizationService);
    return { service, ...host };
  }

  it("registers exactly the three legacy channels", () => {
    expect(setup().channels().sort()).toEqual(
      [
        ipcChannels.organizationCommand,
        ipcChannels.curatorCommand,
        ipcChannels.wikiCollection
      ].sort()
    );
  });

  it("allows only the read commands that still-mounted UI calls", async () => {
    const { service, call } = setup();
    await expect(call(ipcChannels.organizationCommand, { command: "settings" })).resolves.toBe(
      "organization"
    );
    await expect(call(ipcChannels.curatorCommand, { command: "policies" })).resolves.toBe(
      "curator"
    );
    expect(service.command).toHaveBeenCalledWith({ command: "settings" });
    expect(service.automaticCommand).toHaveBeenCalledWith({ command: "policies" });
    expect([...organizationReadCommands]).toEqual(["settings"]);
    expect([...curatorReadCommands]).toEqual(["policies"]);
    expect([...wikiCollectionReadCommands]).toEqual([]);
  });

  it("keeps validating an allowed read", async () => {
    const { service, call } = setup();
    await expect(
      call(ipcChannels.organizationCommand, { command: "settings", extra: true })
    ).rejects.toThrow();
    expect(service.command).not.toHaveBeenCalled();
  });

  it("retires every other command of every schema, whatever its payload", async () => {
    const { service, call } = setup();
    const cases: Array<[string, string[], ReadonlySet<string>]> = [
      [
        ipcChannels.organizationCommand,
        commandNames(OrganizationCommandSchema),
        organizationReadCommands
      ],
      [ipcChannels.curatorCommand, commandNames(CuratorCommandSchema), curatorReadCommands],
      [
        ipcChannels.wikiCollection,
        commandNames(WikiCollectionCommandSchema),
        wikiCollectionReadCommands
      ]
    ];
    let fenced = 0;
    for (const [channel, names, reads] of cases) {
      expect(names.length).toBeGreaterThan(3);
      for (const name of names.filter((item) => !reads.has(item))) {
        await expect(call(channel, { command: name })).rejects.toThrow(legacyRetiredKey);
        fenced += 1;
      }
    }
    expect(fenced).toBeGreaterThan(30);
    // The writers the retired UI used to reach are all in the fenced set.
    for (const name of ["saveDomains", "saveDraft", "activate", "sample", "start", "review"])
      expect(commandNames(OrganizationCommandSchema)).toContain(name);
    for (const name of ["preview", "activate", "pause", "resume", "start", "accept", "reject"])
      expect(commandNames(CuratorCommandSchema)).toContain(name);
    for (const name of ["bootstrap", "bootstrapPause", "bootstrapResume", "drainImpacts"])
      expect(commandNames(WikiCollectionCommandSchema)).toContain(name);
    expect(service.command).not.toHaveBeenCalled();
    expect(service.automaticCommand).not.toHaveBeenCalled();
    expect(service.collectionCommand).not.toHaveBeenCalled();
  });

  it("retires a command that is not in any schema", async () => {
    const { service, call } = setup();
    await expect(call(ipcChannels.curatorCommand, { command: "somethingNew" })).rejects.toThrow(
      legacyRetiredKey
    );
    await expect(call(ipcChannels.wikiCollection, undefined)).rejects.toThrow(legacyRetiredKey);
    expect(service.automaticCommand).not.toHaveBeenCalled();
    expect(service.collectionCommand).not.toHaveBeenCalled();
  });
});

describe("legacy maintenance channel", () => {
  it("answers the dashboard read and retires every other command", async () => {
    const service = { command: vi.fn(async () => "dashboard") };
    const handler = createMaintenanceCommandHandler(service as unknown as MaintenanceService);
    await expect(handler({}, { command: "dashboard" })).resolves.toBe("dashboard");
    expect(service.command).toHaveBeenCalledWith({ command: "dashboard" });
    expect([...maintenanceReadCommands]).toEqual(["dashboard"]);
    const names = commandNames(MaintenanceCommandSchema).filter((name) => name !== "dashboard");
    expect(names).toEqual(expect.arrayContaining(["save", "run", "pause", "automaticDashboard"]));
    for (const name of names)
      expect(() => handler({}, { command: name })).toThrow(legacyRetiredKey);
    expect(service.command).toHaveBeenCalledOnce();
  });
});

describe("legacy wiki channel", () => {
  function setup() {
    const service = {
      tree: vi.fn(async () => "tree"),
      context: vi.fn(async () => "context"),
      linkedTarget: vi.fn(async () => "linked"),
      resolveLinks: vi.fn(async () => "links"),
      list: vi.fn(async () => "list"),
      get: vi.fn(async () => "get"),
      search: vi.fn(async () => "search"),
      history: vi.fn(async () => "history"),
      save: vi.fn(async () => "saved"),
      move: vi.fn(async () => "moved")
    };
    const host = fakeIpc();
    registerWikiIpc(host.ipc, service as unknown as WikiService);
    return { service, ...host };
  }

  it("retires save and move without calling the service", async () => {
    const { service, call } = setup();
    for (const channel of [ipcChannels.wikiSave, ipcChannels.wikiMove])
      await expect(call(channel, { anything: true })).rejects.toThrow(legacyRetiredKey);
    expect(service.save).not.toHaveBeenCalled();
    expect(service.move).not.toHaveBeenCalled();
  });

  it("keeps the reads", async () => {
    const { service, call } = setup();
    await expect(call(ipcChannels.wikiList)).resolves.toBe("list");
    await expect(
      call(ipcChannels.wikiGet, { id: "6f0b2f1c-3f0a-4b8e-9f4a-0c1d2e3f4a5b" })
    ).resolves.toBe("get");
    await expect(
      call(ipcChannels.wikiHistory, "6f0b2f1c-3f0a-4b8e-9f4a-0c1d2e3f4a5b")
    ).resolves.toBe("history");
    expect(service.list).toHaveBeenCalledOnce();
    expect(service.get).toHaveBeenCalledOnce();
    expect(service.history).toHaveBeenCalledOnce();
  });
});

describe("retired legacy jobs", () => {
  let supervisor: JobSupervisor;
  const job = (type: string, payload: Record<string, unknown> = {}) =>
    ({
      id: "job",
      type,
      status: "running",
      attempts: 1,
      maxAttempts: 3,
      progress: 0.25,
      payload
    }) as unknown as JobRecord;

  beforeEach(() => {
    vi.resetAllMocks();
    // The supervisor's own cancel: the executor passes it, as main/index.ts does.
    const retired = createRetiredJobExecutor((id) => supervisor.requestCancel(id));
    supervisor = new JobSupervisor({
      getPool: () => ({}) as PgPool,
      processOrganization: retired,
      processMaintenance: retired
    });
    mocks.jobs.update.mockImplementation(async (_id: string, input: object) => ({
      id: "job",
      ...input
    }));
  });
  afterEach(async () => {
    await supervisor.stop();
  });

  it("ends a claimed organization job as canceled, never retried, writing no legacy row", async () => {
    const claimed = job("organization", { organizationRunId: "run" });
    mocks.jobs.claimNext.mockResolvedValue(claimed);
    mocks.jobs.findById.mockResolvedValue(claimed);
    mocks.jobs.requestCancel.mockResolvedValue(claimed);
    await supervisor.runOnce();
    expect(mocks.jobs.update).toHaveBeenCalledOnce();
    expect(mocks.jobs.update).toHaveBeenCalledWith(
      "job",
      expect.objectContaining({
        status: "canceled",
        error: null,
        result: { error: legacyRetiredKey, jobType: "organization" },
        lockedAt: null,
        lockedBy: null
      })
    );
    // Not queued again, so never retried; the only legacy call is closing the run that the
    // cancellation owns (an update that creates nothing).
    expect(mocks.jobs.update.mock.calls[0]?.[1]).not.toHaveProperty("runAfter");
    expect(mocks.organization.cancel).toHaveBeenCalledExactlyOnceWith("run");
    expect(mocks.maintenance.cancel).not.toHaveBeenCalled();
  });

  it("ends a claimed maintenance job as canceled too", async () => {
    const claimed = job("maintenance", { maintenanceRunId: "run" });
    mocks.jobs.claimNext.mockResolvedValue(claimed);
    mocks.jobs.findById.mockResolvedValue(claimed);
    mocks.jobs.requestCancel.mockResolvedValue(claimed);
    await supervisor.runOnce();
    expect(mocks.jobs.update).toHaveBeenCalledWith(
      "job",
      expect.objectContaining({
        status: "canceled",
        result: { error: legacyRetiredKey, jobType: "maintenance" }
      })
    );
    expect(mocks.maintenance.cancel).toHaveBeenCalledExactlyOnceWith("run");
    expect(mocks.organization.cancel).not.toHaveBeenCalled();
  });

  it("never claims a queued maintenance job: no readiness check is wired", async () => {
    mocks.jobs.claimNext.mockResolvedValue(null);
    mocks.jobs.nextQueuedOfType.mockResolvedValue(job("maintenance"));
    await expect(supervisor.runOnce()).resolves.toBeNull();
    // One claim, for every type but maintenance; no claim for maintenance follows.
    expect(mocks.jobs.claimNext).toHaveBeenCalledOnce();
    expect(mocks.jobs.claimNext.mock.calls[0]?.[1]).not.toContain("maintenance");
    expect(mocks.jobs.update).not.toHaveBeenCalled();
  });
});

describe("main process wiring", () => {
  async function indexSource() {
    return readFile(join(process.cwd(), "apps/desktop/src/main/index.ts"), "utf8");
  }

  it("restores only the prompt catalog on start and on a library reset", async () => {
    const source = await indexSource();
    const body = /async function initializeKnowledgeDefaults\(\) \{([\s\S]*?)\n {2}\}/.exec(
      source
    )?.[1];
    expect(body?.trim()).toBe("await promptService.initialize();");
    expect(source).toContain("restoreDefaults: initializeKnowledgeDefaults");
    expect(source).not.toMatch(/initializeAutomation|investigationService\.initialize/);
  });

  it("passes no legacy tick to the job supervisor and fences its two executors", async () => {
    const source = await indexSource();
    const supervisor = /new JobSupervisor\(\{([\s\S]*?)\n {2}\}\);/.exec(source)?.[1] ?? "";
    expect(supervisor).toContain("processMaintenance: retiredJob");
    expect(supervisor).toContain("processOrganization: retiredJob");
    for (const option of ["maintenanceTick", "maintenanceReady", "reconcileOrganization"])
      expect(source).not.toContain(option);
    // The vault projection still reaches the supervisor, so wiki.enqueue keeps running.
    expect(supervisor).toContain("obsidianSyncService,");
    expect(source).not.toContain("maintenanceService.execute");
    expect(source).not.toContain("organizationService.execute");
  });

  it("fences the maintenance channel and leaves the golden runner without legacy services", async () => {
    const source = await indexSource();
    expect(source).toContain("createMaintenanceCommandHandler(maintenanceService)");
    expect(source).not.toMatch(/organization: organizationService|maintenance: maintenanceService/);
  });
});

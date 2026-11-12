// The settings-describe area of the IPC (F5 D17, D30; spec 3.8): what Settings v2 asks of the main
// process to mark a setting "changed from default" and to put one back. `settings.describe` reads
// every setting the registry stores and says, per entry, its value, its default and whether the two
// differ; `settings.reset` puts one entry back through the setting's own writer. The area is wired
// into `DesktopApi` (as members of `settings`), the preload and `registerIpcHandlers`; these are its
// own channels and its own typed surface, so the schemas, the main handlers and the preload bridge
// agree on one source.
import { z } from "zod";

/** The channels of the area, `app:settings-describe:*`; `ipcChannels` names them by area. */
export const settingsDescribeChannels = {
  describe: "app:settings-describe:describe",
  reset: "app:settings-describe:reset"
} as const;
export type SettingsDescribeChannel =
  (typeof settingsDescribeChannels)[keyof typeof settingsDescribeChannels];

/** A value that crosses the process boundary: what JSON holds. */
export type SettingsJson =
  string | number | boolean | null | SettingsJson[] | { [key: string]: SettingsJson };
export const SettingsJsonSchema: z.ZodType<SettingsJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(SettingsJsonSchema),
    z.record(z.string(), SettingsJsonSchema)
  ])
);

/**
 * One stored setting. `value` is what the control shows, never a secret and never a filesystem path
 * (a credential or a folder reads `true` once set and `null` while it is not: the renderer asks the
 * existing getters for more). `default` is the value a reset restores, or null when the default
 * depends on the machine or on another setting and the main process cannot name one; a class route names the profile its setup gives, when that profile exists.
 * `changed` is the marker of Settings v2.
 */
export const SettingDescriptionSchema = z
  .object({
    id: z.string().min(1).max(200),
    value: SettingsJsonSchema,
    default: SettingsJsonSchema.nullable(),
    changed: z.boolean()
  })
  .strict();
export type SettingDescription = z.infer<typeof SettingDescriptionSchema>;

/**
 * Every registry entry that stores something, in the registry's order. An entry whose store cannot
 * be read now (the database is closed, the secure store is locked) is left out, so its marker is
 * simply not drawn; a page, an action or a read-only panel has nothing to describe.
 */
export const SettingsDescribeResultSchema = z
  .object({ entries: z.array(SettingDescriptionSchema).max(500) })
  .strict();
export type SettingsDescribeResult = z.infer<typeof SettingsDescribeResultSchema>;

/**
 * `confirmed` is the person's yes to a reset that throws away something they built; without it that
 * reset writes nothing and answers `pending`. (Saved import plans are not reset at all: the person
 * deletes a plan from Settings, one by one.)
 */
export const SettingsResetInputSchema = z
  .object({ id: z.string().min(1).max(200), confirmed: z.boolean().optional() })
  .strict();
export type SettingsResetInput = z.infer<typeof SettingsResetInputSchema>;

/**
 * The value after the reset. `pending` is true when the setting moves only after a step the person
 * confirms: the Obsidian layout is a journaled migration of the vault's folders (the reset prepares
 * it and the value stays until it is applied); a provider's key goes with its configuration on the Providers page, one confirmed step each.
 */
export const SettingsResetResultSchema = z
  .object({
    id: z.string().min(1).max(200),
    value: SettingsJsonSchema,
    pending: z.literal(true).optional()
  })
  .strict();
export type SettingsResetResult = z.infer<typeof SettingsResetResultSchema>;

export interface SettingsDescribeApi {
  describe: () => Promise<SettingsDescribeResult>;
  reset: (input: SettingsResetInput) => Promise<SettingsResetResult>;
}

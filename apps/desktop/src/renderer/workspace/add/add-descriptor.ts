import {
  GenericDocumentDescriptorSchema,
  type SourceDescriptor,
  type SourceDescriptorDraft
} from "@app/domain";

/**
 * The descriptor a quick add gives a file (D32): the file's own metadata where it has some (title,
 * creators, language, description, date, cover) on a generic document, with the file name as the
 * title when it says none. A person who wants a book or an article with its own fields uses "Mais
 * opções de importação…", the advanced import panel. A value the schema refuses is left out, never
 * the whole add: the minimal descriptor always stands.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/** The file name without its extension: the title when the file names none. */
export function titleFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.[^./\\]{1,12}$/u, "").trim();
  return (stem || fileName).slice(0, 1000);
}

export interface FileForDescriptor {
  fileName: string;
  mimeType: string;
  draft: Pick<SourceDescriptorDraft, "values" | "provenance">;
}

export function descriptorFromFile(file: FileForDescriptor): SourceDescriptor {
  const values = file.draft.values;
  const title = text(values.title, 1000) ?? titleFromFileName(file.fileName);
  const minimal = {
    type: "GenericDocument" as const,
    title,
    language: "und",
    creators: [],
    tags: [],
    provenance: {},
    mimeType: file.mimeType.slice(0, 300)
  };
  const cover = isRecord(values.cover) ? values.cover : null;
  const candidate = {
    ...minimal,
    ...(text(values.language, 16) && String(values.language).length >= 2
      ? { language: text(values.language, 16)! }
      : {}),
    ...(Array.isArray(values.creators) ? { creators: values.creators } : {}),
    ...(text(values.subtitle, 1000) ? { subtitle: text(values.subtitle, 1000)! } : {}),
    ...(text(values.description, 50_000) ? { description: text(values.description, 50_000)! } : {}),
    ...(text(values.publicationDate, 32)
      ? { publicationDate: text(values.publicationDate, 32)! }
      : {}),
    ...(cover && typeof cover.assetId === "string"
      ? {
          cover: {
            assetId: cover.assetId,
            ...(typeof cover.mimeType === "string" ? { mimeType: cover.mimeType } : {})
          }
        }
      : {}),
    provenance: file.draft.provenance
  };
  const full = GenericDocumentDescriptorSchema.safeParse(candidate);
  if (full.success) return full.data;
  // Provenance of a field the schema did not take is not worth refusing the file over.
  const plain = GenericDocumentDescriptorSchema.safeParse({ ...candidate, provenance: {} });
  if (plain.success) return plain.data;
  return GenericDocumentDescriptorSchema.parse(minimal);
}

import path from "node:path";

export type PathValidationCode =
  | "errors.common.validationFailed"
  | "errors.common.missingConfiguration";

export interface PathValidationResult {
  ok: boolean;
  code?: PathValidationCode;
}

function hasNullByte(value: string): boolean {
  return value.includes("\0");
}

function hasTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => segment === "..");
}

export function validateAbsolutePath(value: string | null | undefined): PathValidationResult {
  const pathValue = value?.trim();
  if (!pathValue) {
    return { ok: false, code: "errors.common.validationFailed" };
  }

  if (hasNullByte(pathValue)) {
    return { ok: false, code: "errors.common.validationFailed" };
  }

  if (hasTraversalSegment(pathValue)) {
    return { ok: false, code: "errors.common.validationFailed" };
  }

  if (!path.isAbsolute(pathValue)) {
    return { ok: false, code: "errors.common.validationFailed" };
  }

  return { ok: true };
}

export function validateManagedRoot(value: string | null | undefined): PathValidationResult {
  const root = value?.trim();
  if (!root) {
    return { ok: false, code: "errors.common.missingConfiguration" };
  }

  if (hasNullByte(root)) {
    return { ok: false, code: "errors.common.validationFailed" };
  }

  if (path.isAbsolute(root)) {
    return { ok: false, code: "errors.common.validationFailed" };
  }

  if (hasTraversalSegment(root)) {
    return { ok: false, code: "errors.common.validationFailed" };
  }

  const normalized = path.normalize(root);
  if (normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return { ok: false, code: "errors.common.validationFailed" };
  }

  return { ok: true };
}

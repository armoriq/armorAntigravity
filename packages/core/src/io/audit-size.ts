import contract from "../contracts/block-capture-v1.json" with { type: "json" };

export type SizeLimits = { maxRowBytes: number; maxBatchBytes: number; maxBatchRows: number; truncationMarker: Record<string, unknown> };

export function validateSizeLimits(limits: SizeLimits): SizeLimits {
  if (![limits?.maxRowBytes, limits?.maxBatchBytes, limits?.maxBatchRows].every(n => Number.isSafeInteger(n) && n > 0) ||
      limits.maxBatchBytes < limits.maxRowBytes + 11 || !limits.truncationMarker || typeof limits.truncationMarker !== "object" || Array.isArray(limits.truncationMarker)) {
    throw new Error("invalid audit size contract");
  }
  return structuredClone(limits);
}

export const AUDIT_SIZE_LIMITS = validateSizeLimits(contract.sizeLimits);
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

export function fitRow<T>(item: T, limits: SizeLimits): { item: T; oversize: boolean } {
  const copy = JSON.parse(JSON.stringify(item)) as T;
  if (jsonBytes(copy) <= limits.maxRowBytes) return { item: copy, oversize: false };
  for (const field of ["input", "output"] as const) {
    (copy as Record<string, unknown>)[field] = structuredClone(limits.truncationMarker);
    if (jsonBytes(copy) <= limits.maxRowBytes) return { item: copy, oversize: false };
  }
  return { item: JSON.parse(JSON.stringify(item)) as T, oversize: true };
}

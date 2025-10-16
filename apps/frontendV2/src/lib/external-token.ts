export interface ExternalTokenPayload {
  symbol: string;
  name: string;
  provider?: string;
  type?: string;
  metadata?: Record<string, unknown>;
}

const PREFIX = "external:" as const;

export function isExternalTokenValue(
  value: string | undefined | null
): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function buildExternalTokenValue(payload: ExternalTokenPayload): string {
  return `${PREFIX}${payload.symbol}:${JSON.stringify(payload)}`;
}

export function parseExternalTokenValue(
  value: string
): ExternalTokenPayload | null {
  if (!isExternalTokenValue(value)) return null;
  try {
    const parts = value.split(":");
    const json = parts.slice(2).join(":");
    const parsed = JSON.parse(json) as ExternalTokenPayload;
    return parsed &&
      typeof parsed.symbol === "string" &&
      typeof parsed.name === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

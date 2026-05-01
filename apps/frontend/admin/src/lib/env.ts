export function getEnv(key: string): string | undefined {
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
}

export function requireEnv(key: string): string {
  const value = getEnv(key);
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value;
}

import { expect, test } from 'bun:test';

const compose = Bun.YAML.parse(
  await Bun.file(new URL('../../docker-compose.prod.yml', import.meta.url)).text()
) as { services: Record<string, { environment: Record<string, string> }> };
test('self-hosted API and worker receive local S3, tier selection, and Tier 1 provider keys', () => {
  for (const name of ['api', 'worker']) {
    const env = compose.services[name]?.environment;
    expect(env?.SCANI_DEPLOYMENT_TIER).toBe('${SCANI_DEPLOYMENT_TIER:-1}');
    for (const key of [
      'S3_ENDPOINT',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'S3_BUCKET',
      'OPENAI_API_KEY',
      'COINGECKO_API_KEY',
      'FINNHUB_API_KEY',
      'ETHERSCAN_API_KEY',
      'HELIUS_API_KEY',
      'GOOGLE_SERVICE_ACCOUNT_KEY',
      'GOOGLE_SHEETS_ID',
      'SMTP_URL',
    ])
      expect(env?.[key]).toBeDefined();
  }
});
test('Tier 2 overlay keeps storage and disables unused local cloud service dependencies', async () => {
  const overlay = Bun.YAML.parse(
    await Bun.file(new URL('../../docker-compose.tier2.yml', import.meta.url)).text()
  ) as {
    services: Record<
      string,
      { profiles?: string[]; depends_on?: Record<string, { required: boolean }> }
    >;
  };
  expect(overlay.services['data-provider']?.profiles).toEqual(['local-providers']);
  expect(overlay.services.api?.depends_on?.['data-provider']?.required).toBe(false);
  expect(overlay.services.worker?.depends_on?.['data-provider']?.required).toBe(false);
  expect(overlay.services.minio).toBeUndefined();
});

test('bundled storage is authenticated SeaweedFS with a separate persistent volume', () => {
  const storage = compose.services.seaweedfs as unknown as {
    image: string;
    environment: Record<string, string>;
    volumes: string[];
    ports: string[];
  };
  expect(storage.image).toMatch(/^chrislusf\/seaweedfs:4\.47@sha256:/);
  expect(storage.environment.AWS_ACCESS_KEY_ID).toContain('S3_ACCESS_KEY_ID');
  expect(storage.environment.AWS_SECRET_ACCESS_KEY).toContain('S3_SECRET_ACCESS_KEY');
  expect(storage.volumes).toEqual(['seaweedfs-data:/data']);
  expect(storage.ports.every((p) => p.startsWith('127.0.0.1:'))).toBe(true);
  expect(compose.services.minio).toBeUndefined();
});

test('browser CSP permits the configured local S3 endpoint', () => {
  expect(compose.services['frontend-app']?.environment.CSP_CONNECT_SRC).toContain(
    'S3_PUBLIC_ENDPOINT'
  );
  expect(compose.services.api?.environment.S3_PUBLIC_ENDPOINT).toContain('SEAWEEDFS_S3_HOST_PORT');
});

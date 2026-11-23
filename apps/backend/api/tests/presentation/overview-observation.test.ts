import { expect, test } from 'bun:test';

test('the shipped overview emits bounded root fields and unsampled completion JSON, without payloads', async () => {
  const proc = Bun.spawn(
    ['bun', 'apps/backend/api/tests/fixtures/overview-observation.fixture.ts'],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOG_PRETTY: 'false',
        LOG_LEVEL: 'info',
        LOG_REQUEST_BODIES: 'false',
        LOG_RESPONSE_BODIES: 'false',
        SENTRY_DSN: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`fixture failed (${code}): ${stderr}\n${stdout}`);
  const resultLine = stdout.split('\n').find((line) => line.startsWith('OVERVIEW_RESULT '));
  if (!resultLine) throw new Error(`fixture missing result: ${stderr}\n${stdout}`);
  const result = JSON.parse(resultLine.slice('OVERVIEW_RESULT '.length));
  const logs = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  const overview = logs.filter((line) => line.procedure === 'dashboard.getOverview');
  expect(overview).toHaveLength(result.calls);
  const completed = overview.filter((line) => line['overview.completeness'] === 'complete');
  expect(completed).toHaveLength(303);
  expect(overview.find((line) => line.requestId === 'parallel-reuse')?.['overview.cache']).toBe(
    'request_reuse'
  );
  expect(
    overview.find((line) => line.requestId === 'parallel-projection')?.['overview.cache']
  ).toBe('projection_hit');
  const partial = overview.find((line) => line.requestId === 'partial');
  expect(partial).toMatchObject({ 'overview.completeness': 'partial', 'overview.cache': 'error' });
  expect(Object.hasOwn(partial, 'overview.details_read_ms')).toBe(false);
  expect(Object.hasOwn(partial, 'overview.compose_ms')).toBe(false);
  expect(overview.find((line) => line.requestId === 'refused')).toMatchObject({
    'overview.completeness': 'partial',
    'overview.cache': 'unknown',
  });
  expect(
    Object.hasOwn(
      logs.find((line) => line.procedure === 'unrelated'),
      'overview.schema'
    )
  ).toBe(false);
  expect(result.roots.length).toBeGreaterThan(0);
  expect(result.roots.length).toBeLessThan(result.calls);
  const fields = [
    'overview.schema',
    'overview.completeness',
    'overview.cache',
    'overview.portfolio_ms',
    'overview.details_read_ms',
    'overview.presence_read_ms',
    'overview.compose_ms',
  ];
  for (const log of completed) {
    expect(
      Object.keys(log)
        .filter((key) => key.startsWith('overview.'))
        .sort()
    ).toEqual([...fields].sort());
  }
  for (const root of result.roots) {
    const data = root.contexts.trace.data;
    expect(data['overview.schema']).toBe(1);
    for (const key of Object.keys(data).filter((key) => key.startsWith('overview.')))
      expect(fields).toContain(key);
    if (data['overview.completeness'] === 'complete') {
      expect(['projection_hit', 'request_reuse']).toContain(data['overview.cache']);
      for (const key of fields.filter((key) => key.endsWith('_ms'))) {
        expect(Number.isFinite(data[key])).toBe(true);
        expect(data[key]).toBeGreaterThanOrEqual(0);
      }
    }
  }
  expect(stdout).not.toContain('OVERVIEW_PRIVATE_SENTINEL');
  expect(stdout).not.toContain('981723.456');
});

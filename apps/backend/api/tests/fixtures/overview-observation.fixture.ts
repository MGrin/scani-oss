import 'reflect-metadata';
import {
  AccountRepository,
  GroupRepository,
  HoldingRepository,
  HoldingTransactionRepository,
  VaultRepository,
} from '@scani/domain/repositories';
import {
  AssetAllocationService,
  DashboardService,
  PortfolioValuationService,
} from '@scani/domain/services';
import { flushSentry, initSentry } from '@scani/logging/sentry';
import { Container } from 'typedi';
import { requireAuth } from '../../src/presentation/middleware/auth';
import { dashboardRouter } from '../../src/presentation/routers/dashboard';
import {
  type Context,
  protectedProcedure,
  publicProcedure,
  router,
} from '../../src/presentation/trpc';

const sentinel = 'OVERVIEW_PRIVATE_SENTINEL';
const transactions: Array<Record<string, unknown>> = [];
const sink = Bun.serve({
  port: 0,
  async fetch(req) {
    const bytes = new Uint8Array(await req.arrayBuffer());
    const decoded = req.headers.get('content-encoding') === 'gzip' ? Bun.gunzipSync(bytes) : bytes;
    const lines = new TextDecoder().decode(decoded).split('\n').filter(Boolean);
    for (let i = 1; i < lines.length; i += 2) {
      if (JSON.parse(lines[i]!).type === 'transaction')
        transactions.push(JSON.parse(lines[i + 1]!));
    }
    return new Response('{}');
  },
});
process.env.SENTRY_DSN = `http://localtest@127.0.0.1:${sink.port}/1`;
if (!process.argv.includes('--no-dsn')) initSentry({ component: 'backend' });

Container.set(PortfolioValuationService, {
  async getUserPortfolioValue(
    _user: string,
    _base: string,
    _account: unknown,
    _cache: unknown,
    _hidden: boolean,
    observer?: (o: unknown) => void
  ) {
    observer?.({
      cache: _user.endsWith('reuse') ? 'request_reuse' : 'projection_hit',
      payload: sentinel,
      userId: sentinel,
      cacheKey: sentinel,
      amount: '981723.456',
    });
    return { totalValue: '981723.456', baseCurrency: sentinel, holdings: [] };
  },
} as unknown as PortfolioValuationService);
Container.set(HoldingRepository, {
  async findByUserWithFullDetails() {
    return [];
  },
} as unknown as HoldingRepository);
Container.set(GroupRepository, {
  async hasActiveForUser() {
    return false;
  },
} as unknown as GroupRepository);
Container.set(VaultRepository, {
  async hasActiveForUser() {
    return false;
  },
} as unknown as VaultRepository);
Container.set(AccountRepository, {
  async hasWrappedAssetAccount() {
    return false;
  },
} as unknown as AccountRepository);
Container.set(HoldingTransactionRepository, {
  async hasIncomeForUser() {
    return false;
  },
} as unknown as HoldingTransactionRepository);
Container.set(AssetAllocationService, {
  async calculateFromFetchedData() {
    return {
      items: [],
      totalDebt: '0',
      liabilityDebt: '0',
      totalValue: '981723.456',
      baseCurrency: sentinel,
    };
  },
} as unknown as AssetAllocationService);
Container.set(DashboardService, new DashboardService());
const app = router({
  dashboard: dashboardRouter,
  unrelated: publicProcedure.query(() => 'ok'),
  baseline: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return Container.get(DashboardService).getDashboardOverview(
      dbUser.id,
      dbUser.baseCurrencyId || undefined,
      ctx.requestCache
    );
  }),
});
function context(id: string): Context {
  return {
    requestId: id,
    startTime: Date.now(),
    requestCache: new Map(),
    headers: null,
    sessionRevokeLimiter: null,
    userId: sentinel,
    isAuthenticated: true,
    email: `${sentinel}@invalid.test`,
    dbUser: { id: sentinel, baseCurrencyId: sentinel },
  } as unknown as Context;
}
if (process.argv.includes('--benchmark')) {
  const rounds: Array<{ baseline: number[]; observed: number[] }> = [];
  for (let round = 0; round < 5; round++) {
    const samples = { baseline: [] as number[], observed: [] as number[] };
    for (let i = 0; i < 200; i++) {
      for (const arm of (i + round) % 2 === 0
        ? (['baseline', 'observed'] as const)
        : (['observed', 'baseline'] as const)) {
        const caller = app.createCaller(context('overhead'));
        const start = performance.now();
        if (arm === 'baseline') await caller.baseline();
        else await caller.dashboard.getOverview();
        samples[arm].push(performance.now() - start);
      }
    }
    rounds.push(samples);
    await flushSentry(5000);
  }
  console.log(
    `OVERVIEW_OVERHEAD ${JSON.stringify({ bun: Bun.version, arch: process.arch, mode: process.argv.includes('--no-dsn') ? 'no_dsn' : 'local_sdk_sink', rounds })}`
  );
  sink.stop();
  process.exit(0);
}
const shared = context('batch');
await Promise.all([
  app.createCaller(shared).dashboard.getOverview({ secret: sentinel } as never),
  app.createCaller(shared).unrelated(),
]);
if (shared.overviewObservation) throw new Error('shared HTTP context was mutated');
for (let i = 0; i < 300; i++) {
  await app
    .createCaller(context(`request-${i}`))
    .dashboard.getOverview({ secret: sentinel } as never);
}
const reused = context('parallel-reuse');
reused.dbUser = { ...reused.dbUser!, id: `${sentinel}-reuse` };
await Promise.all([
  app.createCaller(reused).dashboard.getOverview(),
  app.createCaller(context('parallel-projection')).dashboard.getOverview(),
]);
let releaseDetails!: () => void;
const heldDetails = new Promise<never[]>((resolve) => {
  releaseDetails = () => resolve([]);
});
Container.get(HoldingRepository).findByUserWithFullDetails = () => heldDetails;
Container.get(PortfolioValuationService).getUserPortfolioValue = async (
  _user,
  _base,
  _account,
  _cache,
  _hidden,
  observer
) => {
  observer?.({ cache: 'error' });
  throw new Error('original portfolio failure');
};
const partial = await app
  .createCaller(context('partial'))
  .dashboard.getOverview()
  .catch((error) => error);
if (partial.message !== 'original portfolio failure') throw new Error('procedure error changed');
releaseDetails();
await Bun.sleep(0);
await app
  .createCaller({ ...context('refused'), userId: null, isAuthenticated: false })
  .dashboard.getOverview()
  .catch(() => {});
await flushSentry(5000);
await Bun.sleep(150);
const roots = transactions.filter((t) => t.transaction === 'trpc/dashboard.getOverview');
console.log(`OVERVIEW_RESULT ${JSON.stringify({ calls: 305, roots })}`);
sink.stop();
process.exit(0);

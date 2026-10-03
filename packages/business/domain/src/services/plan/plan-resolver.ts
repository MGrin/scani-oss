import { Container, Token } from 'typedi';

type PlanTier = 'unlimited' | 'paid' | 'free';
type PlanGate = 'none' | 'checkout-required';

export interface PlanAccess {
  tier: PlanTier;
  gate: PlanGate;
  state: string;
  until: Date | null;
  grants: { app: boolean; cloud: boolean };
  aiMonthlyCap: number | null;
}

export interface PlanResolver {
  forUser(userId: string, at?: Date): Promise<PlanAccess>;
}

export const PLAN_RESOLVER = new Token<PlanResolver>('PlanResolver');

export const UNLIMITED_ACCESS: PlanAccess = {
  tier: 'unlimited',
  gate: 'none',
  state: 'self-host',
  until: null,
  grants: { app: true, cloud: true },
  aiMonthlyCap: null,
};

const unlimitedResolver: PlanResolver = {
  forUser: async () => UNLIMITED_ACCESS,
};

export function registerPlanResolver(resolver: PlanResolver): void {
  Container.set(PLAN_RESOLVER, resolver);
}

export function getPlanResolver(): PlanResolver {
  return Container.has(PLAN_RESOLVER) ? Container.get(PLAN_RESOLVER) : unlimitedResolver;
}

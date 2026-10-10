/**
 * Whether a user may use agent access: personal access tokens and `/mcp`
 * (SC-1614). Without a registered gate the answer is `SCANI_AGENT_ACCESS=1`
 * for everyone; a deployment with feature flags registers its own.
 */
type AgentAccessGate = (userId: string) => Promise<boolean>;

const envGate: AgentAccessGate = async () => Bun.env.SCANI_AGENT_ACCESS === '1';

let gate: AgentAccessGate = envGate;

/** @public A deployment with feature flags registers its own gate here. */
export function registerAgentAccessGate(next: AgentAccessGate): void {
  gate = next;
}

export function agentAccessAllowed(userId: string): Promise<boolean> {
  return gate(userId);
}

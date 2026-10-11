import { db } from '@scani/db/connection';
import { agentCalls } from '@scani/db/schema';
import { sql } from 'drizzle-orm';
import { Service } from 'typedi';

/**
 * One row per tool call an agent makes through `/mcp` (SC-1618), refused and
 * failed calls included, so the user can see what their agents asked for.
 */

type AgentCallOutcome = 'ok' | 'error' | 'refused';

const ARGS_SUMMARY_MAX = 300;

export interface AgentCallEntry {
  userId: string;
  actor: string;
  tool: string;
  args: unknown;
  outcome: AgentCallOutcome;
  durationMs: number;
  agentWriteId?: string | null;
}

export interface AgentCallSummary {
  id: string;
  tool: string;
  argsSummary: string;
  outcome: AgentCallOutcome;
  durationMs: number;
  agentWriteId: string | null;
  /** The token's or connected app's name; null once it is gone. */
  actorName: string | null;
  createdAt: Date;
}

function summariseArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {}) ?? '{}';
  } catch {
    text = String(args);
  }
  return text.length > ARGS_SUMMARY_MAX ? `${text.slice(0, ARGS_SUMMARY_MAX - 1)}…` : text;
}

@Service()
export class AgentCallLog {
  async record(entry: AgentCallEntry): Promise<void> {
    await db.insert(agentCalls).values({
      userId: entry.userId,
      actor: entry.actor,
      tool: entry.tool,
      argsSummary: summariseArgs(entry.args),
      outcome: entry.outcome,
      durationMs: Math.max(0, Math.round(entry.durationMs)),
      agentWriteId: entry.agentWriteId ?? null,
    });
  }

  async list(userId: string, limit = 100): Promise<AgentCallSummary[]> {
    const rows = await db.execute<{
      id: string;
      tool: string;
      args_summary: string;
      outcome: AgentCallOutcome;
      duration_ms: number;
      agent_write_id: string | null;
      actor_name: string | null;
      created_at: string;
    }>(sql`
      SELECT c.id, c.tool, c.args_summary, c.outcome, c.duration_ms, c.agent_write_id,
             coalesce(p.name, oc.name) AS actor_name, c.created_at
      FROM agent_calls c
      LEFT JOIN personal_access_tokens p ON p.id::text = c.actor AND p.user_id = c.user_id
      LEFT JOIN oauth_client oc ON 'oauth:' || oc.client_id = c.actor
      WHERE c.user_id = ${userId}
      ORDER BY c.created_at DESC
      LIMIT ${limit}
    `);
    return rows.map((r) => ({
      id: r.id,
      tool: r.tool,
      argsSummary: r.args_summary,
      outcome: r.outcome,
      durationMs: r.duration_ms,
      agentWriteId: r.agent_write_id,
      actorName: r.actor_name,
      createdAt: new Date(r.created_at),
    }));
  }
}

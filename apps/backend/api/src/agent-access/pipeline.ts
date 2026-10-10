import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import type { InflowRateLimiter } from '@scani/rate-limiter';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import {
  AgentWriteBusyError,
  AgentWriteJournal,
  AgentWriteKeyReuseError,
  AgentWriteKeyUnfinishedError,
} from '../agent-writes/journal';
import { AGENT_WRITE_SCOPE, type VerifiedPersonalToken } from '../auth/personal-access-tokens';
import { AgentCallLog } from '../mcp/call-log';
import { TOOL_OUTPUTS } from '../mcp/outputs';
import { compact, MCP_TOOLS, type McpTool } from '../mcp/tools';
import { MCP_WRITE_SUPPORT_TOOLS, MCP_WRITE_TOOLS } from '../mcp/write-tools';
import { appRouter } from '../presentation/router';
import { type Context, createAgentContext } from '../presentation/trpc';

/**
 * What every agent request goes through, whichever transport carried it
 * (SC-1648): the token, its rate budget, the access gate, the write scope, the
 * journal and the call log. `/mcp` and `/api/v1` both call this and add only
 * their own framing, so there is one auth path and one set of tenancy checks.
 */

const log = createComponentLogger('agent-access');

const declared = (tool: McpTool): McpTool => ({ ...tool, output: TOOL_OUTPUTS[tool.name] });

export const READ_TOOLS: readonly McpTool[] = [...MCP_TOOLS, ...MCP_WRITE_SUPPORT_TOOLS].map(
  declared
);
export const ALL_TOOLS: readonly McpTool[] = [...READ_TOOLS, ...MCP_WRITE_TOOLS.map(declared)];

export function canWrite(verified: VerifiedPersonalToken): boolean {
  return verified.scopes.includes(AGENT_WRITE_SCOPE);
}

type AgentUser = typeof schema.users.$inferSelect;

export interface AgentDeps {
  verifyToken: (raw: string) => Promise<VerifiedPersonalToken | null>;
  accessAllowed: (userId: string) => Promise<boolean>;
  loadUser: (userId: string) => Promise<AgentUser | null>;
  limiter: Pick<InflowRateLimiter, 'tryConsumeKey'>;
  /** The heavy reads' budget, keyed by user. */
  heavyLimiter: Pick<InflowRateLimiter, 'tryConsumeKey'>;
  buildContext: (user: AgentUser, tokenId: string, writablePaths?: readonly string[]) => Context;
  journal: Pick<AgentWriteJournal, 'record'>;
  callLog: Pick<AgentCallLog, 'record'>;
  /** The API's public origin; the request's own when absent. */
  publicBaseUrl?: string;
}

export function createAgentDeps(opts: {
  verifyToken: AgentDeps['verifyToken'];
  accessAllowed: AgentDeps['accessAllowed'];
  limiter: AgentDeps['limiter'];
  heavyLimiter: AgentDeps['heavyLimiter'];
  publicBaseUrl?: string;
}): AgentDeps {
  return {
    verifyToken: opts.verifyToken,
    publicBaseUrl: opts.publicBaseUrl,
    accessAllowed: opts.accessAllowed,
    loadUser: async (userId) => {
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      return user ?? null;
    },
    limiter: opts.limiter,
    heavyLimiter: opts.heavyLimiter,
    buildContext: createAgentContext,
    journal: Container.get(AgentWriteJournal),
    callLog: Container.get(AgentCallLog),
  };
}

export interface AgentPrincipal {
  user: AgentUser;
  verified: VerifiedPersonalToken;
}

export type Admission =
  | ({ ok: true } & AgentPrincipal)
  | { ok: false; reason: 'unauthenticated' | 'agent_access_off' | 'unknown_user' }
  | { ok: false; reason: 'rate_limited'; retryAfterSec: number };

function bearer(req: Request): string | null {
  const header = req.headers.get('authorization');
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return match?.[1] ?? null;
}

/** Who is asking, and whether they may ask at all right now. */
export async function admit(req: Request, deps: AgentDeps): Promise<Admission> {
  const raw = bearer(req);
  const verified = raw ? await deps.verifyToken(raw) : null;
  if (!verified) return { ok: false, reason: 'unauthenticated' };

  const budget = await deps.limiter.tryConsumeKey(`pat:${verified.tokenId}`);
  if (!budget.ok) return { ok: false, reason: 'rate_limited', retryAfterSec: budget.retryAfterSec };

  if (!(await deps.accessAllowed(verified.userId)))
    return { ok: false, reason: 'agent_access_off' };

  const user = await deps.loadUser(verified.userId);
  if (!user) return { ok: false, reason: 'unknown_user' };
  return { ok: true, user, verified };
}

export type ToolOutcome =
  | { kind: 'ok'; value: Record<string, unknown>; agentWriteId?: string }
  | {
      kind: 'refused';
      code: 'unknown_tool' | 'read_only_token' | 'invalid_input';
      message: string;
      issues?: string[];
    }
  | { kind: 'refused'; code: 'rate_limited'; message: string; retryAfterSec: number }
  /** `code` is the tRPC code, `busy` for a write already in flight, or `internal`. */
  | { kind: 'error'; code: string; message: string };

export interface ToolCallOptions {
  /** A journaled write under this key runs once; a repeat is answered from its record. */
  idempotencyKey?: string;
  /**
   * Refuse a field the tool's schema would drop, at any depth, instead of
   * running without it. REST promises this; `/mcp` keeps zod's own answer.
   */
  refuseDroppedFields?: boolean;
}

const NOT_A_FIELD = 'not a field of this request';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Every path the client sent that the parsed input no longer has: a nested
 * misspelling, or a field that belongs to another variant of a union.
 */
function droppedFields(sent: unknown, parsed: unknown, path: string[] = []): string[] {
  if (Array.isArray(sent) && Array.isArray(parsed)) {
    return sent.flatMap((item, i) => droppedFields(item, parsed[i], [...path, String(i)]));
  }
  if (!isPlainObject(sent) || !isPlainObject(parsed)) return [];
  return Object.entries(sent).flatMap(([key, value]) =>
    Object.hasOwn(parsed, key)
      ? droppedFields(value, parsed[key], [...path, key])
      : [`${[...path, key].join('.')}: ${NOT_A_FIELD}`]
  );
}

function invalidInput(issues: string[]): ToolOutcome {
  return {
    kind: 'refused',
    code: 'invalid_input',
    message: `Invalid arguments — ${issues.join('; ')}`,
    issues,
  };
}

/**
 * Runs one tool for one principal. Every call is logged once (SC-1618),
 * whatever happens to it, and the row is written before the answer goes back.
 */
export async function executeTool(
  name: string,
  args: unknown,
  who: AgentPrincipal,
  deps: AgentDeps,
  opts: ToolCallOptions = {}
): Promise<ToolOutcome> {
  const started = performance.now();
  return logged(name, args, who, deps, started, await run(name, args, who, deps, opts));
}

/**
 * A request its transport already found malformed, before a tool could parse
 * it. Logged as a refused call, so the user sees it beside the others.
 */
export function refuseCall(
  name: string,
  args: unknown,
  who: AgentPrincipal,
  deps: AgentDeps,
  issues: string[]
): Promise<ToolOutcome> {
  return logged(name, args, who, deps, performance.now(), {
    kind: 'refused',
    code: 'invalid_input',
    message: `Invalid arguments — ${issues.join('; ')}`,
    issues,
  });
}

async function logged(
  name: string,
  args: unknown,
  who: AgentPrincipal,
  deps: AgentDeps,
  started: number,
  outcome: ToolOutcome
): Promise<ToolOutcome> {
  try {
    await deps.callLog.record({
      userId: who.user.id,
      actor: who.verified.tokenId,
      tool: name,
      args: args ?? {},
      outcome: outcome.kind,
      durationMs: performance.now() - started,
      agentWriteId: outcome.kind === 'ok' ? outcome.agentWriteId : undefined,
    });
  } catch (error) {
    log.error(
      {
        tokenId: who.verified.tokenId,
        error: error instanceof Error ? error.message : String(error),
      },
      'Agent call could not be logged'
    );
  }
  return outcome;
}

async function run(
  name: string,
  args: unknown,
  who: AgentPrincipal,
  deps: AgentDeps,
  opts: ToolCallOptions
): Promise<ToolOutcome> {
  const tokenId = who.verified.tokenId;
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) return { kind: 'refused', code: 'unknown_tool', message: `Unknown tool: ${name}` };
  if (tool.writes && !canWrite(who.verified)) {
    return {
      kind: 'refused',
      code: 'read_only_token',
      message:
        'This token is read-only. Create a token that allows changes in Scani Settings to use write tools.',
    };
  }

  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    return invalidInput(
      parsed.error.issues.flatMap((i) =>
        // A strict object names its unknown keys in one issue; REST names each by its path.
        opts.refuseDroppedFields && i.code === 'unrecognized_keys'
          ? i.keys.map((key) => `${[...i.path, key].join('.')}: ${NOT_A_FIELD}`)
          : [`${i.path.join('.') || '(input)'}: ${i.message}`]
      )
    );
  }
  if (opts.refuseDroppedFields) {
    const dropped = droppedFields(args ?? {}, parsed.data);
    if (dropped.length > 0) return invalidInput(dropped);
  }

  if (tool.heavy) {
    const budget = await deps.heavyLimiter.tryConsumeKey(`user:${who.user.id}`);
    if (!budget.ok) {
      return {
        kind: 'refused',
        code: 'rate_limited',
        message: 'Too many heavy reads for this account in the last minute. Retry later.',
        retryAfterSec: budget.retryAfterSec,
      };
    }
  }

  const caller = appRouter.createCaller(deps.buildContext(who.user, tokenId, tool.writes ?? []));
  try {
    const result = compact(await runTool(tool, caller, parsed.data, who, deps, opts));
    // `structuredContent` is an object before protocol 2026-07-28.
    const value = (
      result && typeof result === 'object' && !Array.isArray(result) ? result : { result }
    ) as Record<string, unknown>;
    const agentWriteId = typeof value.agentChangeId === 'string' ? value.agentChangeId : undefined;
    return { kind: 'ok', value, agentWriteId };
  } catch (error) {
    if (error instanceof AgentWriteKeyReuseError || error instanceof AgentWriteKeyUnfinishedError) {
      return { kind: 'error', code: 'CONFLICT', message: error.message };
    }
    if (error instanceof AgentWriteBusyError) {
      return { kind: 'error', code: 'busy', message: error.message };
    }
    if (error instanceof TRPCError && error.code !== 'INTERNAL_SERVER_ERROR') {
      return { kind: 'error', code: error.code, message: error.message };
    }
    log.error(
      { tool: tool.name, tokenId, error: error instanceof Error ? error.message : String(error) },
      'Agent tool failed'
    );
    return {
      kind: 'error',
      code: 'internal',
      message: 'The tool failed on the server. Try again later.',
    };
  }
}

/** A write runs inside the journal, and its answer names the change to undo. */
async function runTool(
  tool: McpTool,
  caller: ReturnType<typeof appRouter.createCaller>,
  input: Record<string, unknown>,
  who: AgentPrincipal,
  deps: AgentDeps,
  opts: ToolCallOptions
): Promise<unknown> {
  if (!tool.writes || tool.unjournaled) return tool.run(caller, input);
  const recorded = await deps.journal.record(
    {
      userId: who.user.id,
      actor: who.verified.tokenId,
      tool: tool.name,
      input,
      idempotencyKey: opts.idempotencyKey,
    },
    () => tool.run(caller, input)
  );
  return {
    agentChangeId: recorded.writeId,
    rowsChanged: recorded.changeCount,
    result: recorded.result,
    replayed: recorded.replayed,
  };
}

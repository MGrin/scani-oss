#!/usr/bin/env bun
/**
 * Reclaim the compose projects whose checkout has been deleted (SC-803).
 *
 *   bun run dev:stacks:reap                    # DRY RUN — says what it would take
 *   bun run dev:stacks:reap -- --apply         # actually take it
 *   bun run dev:stacks:reap -- --project <p>   # one project, same guard
 *
 * DRY RUN IS THE DEFAULT AND `--apply` IS THE ONLY WAY PAST IT. What it removes
 * are per-checkout dev volumes, which a later `bun dev:stack` recreates and
 * migrates from scratch — but "recreatable" is a claim about the SCHEMA, not
 * about whatever somebody put in one, and the person who would know went with
 * the checkout. See `lib/stack-reaper.ts` for what it refuses and why; every
 * way of not knowing refuses rather than reclaiming.
 *
 * `bun run dev:stacks` is the reporter and stays one — it stops nothing and
 * removes nothing. This is the deliberate second command.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { classifyDockerProbe, type DockerProbe, probeWithRetry } from './lib/port-holder';
import { censusFromMachine } from './lib/stack-census';
import {
  type ActionResult,
  describeKeptProjects,
  describePlan,
  describeReap,
  planReap,
  type ReapActions,
  reapExit,
  sweep,
} from './lib/stack-reaper';
import { composeProjectName } from './lib/worktree';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

const USAGE =
  'reap-stacks: usage: bun scripts/reap-stacks.ts [--apply] [--project <name>]\n' +
  '  Dry run by default. `bun run dev:stacks` reports without reclaiming anything.\n';

export interface Options {
  readonly apply: boolean;
  readonly project: string | null;
}

/**
 * Parse argv, refusing anything unrecognised rather than ignoring it.
 *
 * An unknown flag is a usage error and not a silent no-op, because the flag a
 * reader is most likely to mistype is `--apply`: dropping it silently would
 * turn an intended teardown into a dry run that reads like one — recoverable —
 * but a mistyped NEGATIVE (`--dryrun`, which does not exist) dropped silently
 * would run the destructive path. The refusal is symmetric so neither can
 * happen (`@scani/memory` learned the same lesson from a flag bag that pulled
 * only the names it knew).
 */
export function parseArgs(argv: readonly string[]): Options | { readonly usage: string } {
  let apply = false;
  let project: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--project') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        return { usage: `reap-stacks: --project needs a project name\n${USAGE}` };
      }
      project = next;
      i += 1;
    } else {
      return { usage: `reap-stacks: unknown argument ${arg}\n${USAGE}` };
    }
  }
  return { apply, project };
}

function run(argv: readonly string[]): ActionResult {
  const probe = spawnSync(argv[0] as string, argv.slice(1), {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (probe.status === 0) return { ok: true };
  // The FIRST line, never a substring: docker prints hints and context below
  // the headline, and a grep over the whole thing reads as whatever the hint
  // happens to quote.
  const stderr = (probe.stderr ?? '').trim().split('\n')[0] ?? '';
  const why = stderr === '' ? `exit ${probe.status ?? 'killed'}` : stderr;
  return { ok: false, why };
}

function probeDocker(argv: readonly string[]): DockerProbe {
  return probeWithRetry((timeout) =>
    classifyDockerProbe(spawnSync(argv[0] as string, argv.slice(1), { encoding: 'utf8', timeout }))
  );
}

/**
 * The real docker calls.
 *
 * `remaining` asks with `-a` for containers, because a stopped leftover holds
 * its name and would fail a later `up` — the same reason `dev-stack.ts` does.
 * It returns `null` on any blind probe rather than an empty result, which is
 * what makes `unverified` a state the sweep can be in.
 */
export const dockerActions: ReapActions = {
  composeDown(project) {
    // `-p` resolves the project from container/volume LABELS, so this needs no
    // compose file and still works after the worktree directory is gone. That
    // is the whole remedy: the supported `bun run dev:stack:down` cannot run
    // from a directory that no longer exists.
    return run(['docker', 'compose', '-p', project, 'down', '--volumes', '--remove-orphans']);
  },
  remaining(project) {
    const label = `label=com.docker.compose.project=${project}`;
    const containers = probeDocker([
      'docker',
      'ps',
      '-a',
      '--format',
      '{{.Names}}',
      '--filter',
      label,
    ]);
    if (containers.kind !== 'ok') return null;
    const volumes = probeDocker([
      'docker',
      'volume',
      'ls',
      '--format',
      '{{.Name}}',
      '--filter',
      label,
    ]);
    if (volumes.kind !== 'ok') return null;
    const lines = (text: string) =>
      text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    return { containers: lines(containers.output).length, volumes: lines(volumes.output) };
  },
  removeVolume(name) {
    return run(['docker', 'volume', 'rm', name]);
  },
};

async function main(): Promise<never> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('usage' in parsed) {
    process.stderr.write(parsed.usage);
    process.exit(64);
  }

  // Sizes, because the number a person acts on is the disk, and this command
  // is not on a hot path — `dev-stack.ts down` pays the cheap probe, this pays
  // the four seconds.
  const census = censusFromMachine(REPO_ROOT, true);
  const plan = planReap(census, composeProjectName(REPO_ROOT), parsed.project);

  if (plan.kind === 'refused') {
    process.stderr.write(`reap-stacks: REFUSED · exit ${plan.exit} · ${plan.reason}\n`);
    process.stderr.write('reap-stacks: NOTHING WAS RECLAIMED\n');
    process.exit(plan.exit);
  }

  process.stderr.write(
    `reap-stacks: judged against the ${plan.checkouts} checkout(s) \`git worktree list\` ` +
      "reports for THIS repository — a separate clone's stack would read as having no " +
      'checkout, so check the names below if there is more than one clone on this machine\n'
  );

  if (plan.reap.length > 0) {
    process.stderr.write(
      `reap-stacks: ${parsed.apply ? 'reclaiming' : 'would reclaim'}\n${describePlan(plan)}\n`
    );
  }

  const report = parsed.apply
    ? sweep(plan, dockerActions)
    : { reaped: plan.reap, failed: [], unverified: [], kept: plan.keep };

  if (report.kept.length > 0) process.stderr.write(`${describeKeptProjects(report)}\n`);
  process.stderr.write(`${describeReap(report, parsed.apply)}\n`);
  if (!parsed.apply && plan.reap.length > 0) {
    process.stderr.write(
      'reap-stacks: nothing was touched. Re-run with `--apply` to reclaim it.\n'
    );
  }
  process.exit(parsed.apply ? reapExit(report) : 0);
}

if (import.meta.main) await main();

import { Button } from '@scani/ui/ui/button';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { jobDetailPath, V3_CAPTURE_ROUTES } from '../../lib/routes';

/**
 * The two states the first screen of an empty account has.
 *
 * The invitation half is what #1069 shipped inline, moved here unchanged in
 * shape — one primary route in, one lower-emphasis press through to the
 * capture sheet. What it did not have is the other half: an account with an
 * import *already running* has no holdings yet, and was told "Nothing tracked
 * yet", which reads as *you have not tried*. That is the SC-153 defect one
 * state along — fixed there for a job that had **died**, left unfixed for one
 * still **running**.
 *
 * Knowing that costs a `jobs.listMine`, which is why this is a component and
 * not more markup in `HomePage`: hooks cannot be called conditionally, so a
 * query lifted into the page would run on the full dashboard too — the app's
 * most-revisited screen, and one already tuned for its cold start (SC-164).
 * `FirstRun` owns the query and mounts only on the empty branch; this half
 * stays free of any import that reaches a tRPC client, which is also what
 * lets it render under `bun test`.
 */

/** Jobs that end in a position existing. `holding-price-update` is not one of
 *  them — it re-prices a holding the account does not have yet. */
const CAPTURE_JOB_NAMES = new Set([
  'manual-holdings-create',
  'screenshot-parse',
  'file-import',
  'wallet-import',
  'exchange-import',
  'transaction-import',
]);

const IN_FLIGHT_STATES = new Set(['queued', 'active', 'progress']);

export type FirstRunState = { kind: 'invite' } | { kind: 'importing'; jobId: string };

/** As much of a `user_jobs` row as the resolver reads. Structural rather than
 *  `UserJobRow` so this module imports nothing that reaches a tRPC client. */
export interface FirstRunJob {
  jobId: string;
  jobName: string;
  state: string;
}

/**
 * Pure, and separate from the render, because it is the whole of what the
 * panel decides and the render cannot be exercised without a router.
 *
 * `jobs` arrives newest-first from `jobs.listMine`, so the first match is the
 * most recent in-flight capture — the one a reader who just pressed Home is
 * waiting on.
 */
export function resolveFirstRunState(jobs: readonly FirstRunJob[]): FirstRunState {
  for (const job of jobs) {
    if (!CAPTURE_JOB_NAMES.has(job.jobName)) continue;
    if (!IN_FLIGHT_STATES.has(job.state)) continue;
    return { kind: 'importing', jobId: job.jobId };
  }
  return { kind: 'invite' };
}

interface FirstRunPanelProps {
  state: FirstRunState;
  /** Opens the capture sheet — the way to every route this screen does not name. */
  onOpenCapture: () => void;
}

export function FirstRunPanel({ state, onOpenCapture }: FirstRunPanelProps) {
  const { t } = useTranslation();
  const importing = state.kind === 'importing';

  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-title">
          {t(importing ? 'v3.home.empty.importing.title' : 'v3.home.empty.title')}
        </h1>
        <p className="text-body text-muted-foreground">
          {t(importing ? 'v3.home.empty.importing.body' : 'v3.home.empty.body')}
        </p>
      </div>

      {state.kind === 'importing' ? (
        <Button asChild>
          <Link to={jobDetailPath(state.jobId)}>
            <Loader2 aria-hidden="true" className="me-2 size-4 animate-spin" />
            {t('v3.home.empty.importing.action')}
          </Link>
        </Button>
      ) : (
        <Button asChild>
          <Link to={V3_CAPTURE_ROUTES.fileImport}>{t('v3.home.empty.action')}</Link>
        </Button>
      )}

      {/* Offered in both states: an import that is running does not stop a
          reader wanting to add the account it does not cover. */}
      <Button variant="link" onClick={onOpenCapture}>
        {t('v3.home.empty.secondaryAction')}
      </Button>
    </>
  );
}

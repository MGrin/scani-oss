import { useUserJobs } from '../../hooks/useUserJobs';
import { FirstRunPanel, resolveFirstRunState } from './FirstRunPanel';

/**
 * `FirstRunPanel` wired to the user's job list.
 *
 * A file of its own for two reasons, both load-bearing. It mounts only on the
 * home screen's empty branch, so a portfolio that already has holdings never
 * pays for the `jobs.listMine` — which it would if the hook were lifted into
 * `HomePage`, since hooks cannot be called conditionally. And `useUserJobs`
 * reaches the realtime context and through it the app's Vite-only i18n
 * bootstrap, which `bun test` cannot evaluate; keeping it out of
 * `FirstRunPanel` is what leaves that half testable.
 *
 * The query itself is the one the jobs page already uses, WS-invalidated, so
 * the screen flips to the portfolio by itself when the parse lands.
 */
export function FirstRun({ onOpenCapture }: { onOpenCapture: () => void }) {
  const { jobs } = useUserJobs();
  return <FirstRunPanel state={resolveFirstRunState(jobs)} onOpenCapture={onOpenCapture} />;
}

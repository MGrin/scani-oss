import { describeJobFailure } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import type { V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { exportDateTime, exportText } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { ListChecks } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { jobLabelFor } from '../../lib/job-labels';
import {
  compareJobs,
  type JobBucket,
  type JobRow,
  jobBucket,
  jobBucketLabel,
  jobBucketOptions,
  jobFailureLabel,
  jobNeedsAction,
  jobStateLabel,
  summariseJobPayload,
} from '../../lib/jobs';
import { formatRelative } from '../../lib/relative-time';
import { jobDetailPath } from '../../lib/routes';
import { useOpenCapture } from '../capture/CaptureSheetContext';
import { JobStateBadge } from './JobStateBadge';

/**
 * Every background job the user has started, as one list.
 *
 * v2 renders four `Card` sections built by four independent `filter` calls,
 * which means three of them are usually empty boxes with a sentence in them,
 * and a job awaiting review appears twice — once in "Needs your review", once
 * in "Completed". Here the four buckets are one value per job (`jobBucket`),
 * offered as a filter and as a group-by, and the default sort is that bucket:
 * the jobs that want something from the user lead the list without a section
 * being permanently reserved for them.
 *
 * Rows navigate rather than peek. A job's detail is its *result* — a parsed
 * document's holdings, an import's confirm step — which is a page's worth of
 * content and its own review renderer, not four facts.
 */

interface JobsListProps {
  jobs: JobRow[];
  query: V3QueryState;
}

/** Urgency, then newest first. The tie-break is what makes the default sort
 *  usable at all: within a bucket, recency is the only order that matters. */
const BUCKET_RANK: Record<JobBucket, number> = { review: 0, running: 1, failed: 2, completed: 3 };

export function JobsList({ jobs, query }: JobsListProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // The capture sheet, not a link: V3-14 made capture shell state precisely so
  // an empty screen — the highest-value place to offer it — can raise it
  // without navigating away from the screen the reader is already on.
  const openCapture = useOpenCapture();

  const config: V3DataViewConfig<JobRow> = {
    pageKey: 'jobs',
    data: jobs,
    nounKey: 'ui.dataView.noun.jobs',
    searchPlaceholderKey: 'ui.dataView.jobs.config.searchJobs',
    searchFn: (job, query) =>
      jobLabelFor(t, job.jobName).label.toLowerCase().includes(query) ||
      (summariseJobPayload(t, job.jobName, job.payloadSummary) ?? '').toLowerCase().includes(query),
    filterDefs: [
      {
        key: 'bucket',
        labelKey: 'ui.dataView.jobs.filter.status',
        options: jobBucketOptions(t, jobs),
        fn: (job: JobRow, value) => jobBucket(job) === value,
      },
    ],
    sortDefs: [
      { key: 'status', labelKey: 'ui.dataView.jobs.sort.status' },
      { key: 'started', labelKey: 'ui.dataView.jobs.sort.started' },
    ],
    sortFn: (a, b, field, direction) => {
      if (field !== 'status') return compareJobs(a, b, field, direction);
      const rank = BUCKET_RANK[jobBucket(a)] - BUCKET_RANK[jobBucket(b)];
      if (rank !== 0) return rank * (direction === 'asc' ? 1 : -1);
      return compareJobs(a, b, 'started', 'desc');
    },
    defaultSort: { field: 'status', direction: 'asc' },
    groupByDefs: [
      {
        key: 'bucket',
        labelKey: 'ui.dataView.jobs.group.status',
        fn: (job: JobRow) => jobBucketLabel(t, jobBucket(job)),
      },
    ],
    renderRow: (job) => {
      const { label, icon: Icon } = jobLabelFor(t, job.jobName);
      const needsAction = jobNeedsAction(job);
      // The chip and the screen-reader label read the same description, so a
      // row cannot say "Failed" aloud while showing "Retrying (1 of 3)".
      const failure = describeJobFailure(job);
      return {
        leading: <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />,
        label,
        sublabel: summariseJobPayload(t, job.jobName, job.payloadSummary) ?? undefined,
        value: <JobStateBadge state={job.state} needsAction={needsAction} failure={job} />,
        delta: <span className="text-muted-foreground">{formatRelative(t, job.createdAt)}</span>,
        ariaLabel: `${label}, ${needsAction ? t('v3.jobs.state.needsReviewSpoken') : failure ? jobFailureLabel(t, failure) : jobStateLabel(t, job.state)}`,
      };
    },
    columns: [
      {
        key: 'job',
        headerKey: 'ui.dataView.jobs.col.job',
        width: 'w-[34%]',
        render: (job) => {
          const { label, icon: Icon } = jobLabelFor(t, job.jobName);
          return (
            <span className="flex min-w-0 items-center gap-2">
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate text-label">{label}</span>
            </span>
          );
        },
        exportValue: (job) => exportText(jobLabelFor(t, job.jobName).label),
      },
      {
        key: 'detail',
        headerKey: 'ui.dataView.jobs.col.detail',
        render: (job) => (
          <span className="truncate text-muted-foreground">
            {summariseJobPayload(t, job.jobName, job.payloadSummary) ?? '—'}
          </span>
        ),
      },
      {
        key: 'status',
        headerKey: 'ui.dataView.jobs.col.status',
        sortable: true,
        width: 'w-40',
        render: (job) => (
          <JobStateBadge state={job.state} needsAction={jobNeedsAction(job)} failure={job} />
        ),
        // The export carries the description rather than the raw state, for the
        // same reason the chip does: `failed` in a spreadsheet cell is the
        // ambiguity this ticket is about, one medium further from help.
        exportValue: (job) => {
          const failure = describeJobFailure(job);
          return exportText(failure ? jobFailureLabel(t, failure) : jobStateLabel(t, job.state));
        },
      },
      {
        key: 'started',
        headerKey: 'ui.dataView.jobs.col.started',
        sortable: true,
        width: 'w-36',
        render: (job) => (
          <span className="text-muted-foreground">{formatRelative(t, job.createdAt)}</span>
        ),
        exportValue: (job) => exportDateTime(job.createdAt),
      },
    ],
    empty: {
      icon: ListChecks,
      titleKey: 'ui.dataView.jobs.empty.noBackgroundJobsYet',
      descriptionKey: 'ui.dataView.jobs.empty.importsParsesAndPriceRefreshesRun',
      action: <Button onClick={openCapture}>{t('v3.jobs.importSomething')}</Button>,
    },
    onRowClick: (job) => navigate(jobDetailPath(job.jobId)),
    rowHref: (job) => jobDetailPath(job.jobId),
  };

  return <V3DataView config={config} getId={(job) => job.jobId} query={query} />;
}

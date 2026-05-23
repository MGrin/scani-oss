import { upsertJobHeartbeat } from '@scani/db';
import { JOB_HEARTBEAT_WRITER, JobHeartbeatWriter, type JobRunOutcome } from '@scani/queue';
import { Service } from 'typedi';

// Concrete heartbeat writer for production use. Persists to the
// `job_heartbeats` table via the @scani/db helper. Failures are
// swallowed inside `upsertJobHeartbeat` — a heartbeat write must
// never fail the job that just succeeded.
@Service({ id: JOB_HEARTBEAT_WRITER })
export class PostgresJobHeartbeatWriter extends JobHeartbeatWriter {
  override async record(outcome: JobRunOutcome): Promise<void> {
    await upsertJobHeartbeat(outcome);
  }
}

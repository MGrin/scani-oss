import { UserJobRepository } from '@scani/domain/repositories';
import { ENQUEUE_MIRROR, type EnqueuedJobMeta, type EnqueueMirror } from '@scani/queue';
import { Container, Service } from 'typedi';

// Persists user-job mirror rows so the /jobs UI has durable history.
// The framework calls onEnqueued before BullMQ.add and onEnqueueFailed
// when add throws — both are idempotent on jobId.
@Service({ id: ENQUEUE_MIRROR })
export class UserJobEnqueueMirror implements EnqueueMirror {
  private readonly repo = Container.get(UserJobRepository);

  async onEnqueued(meta: EnqueuedJobMeta): Promise<void> {
    await this.repo.insertEnqueued({
      jobId: meta.jobId,
      userId: meta.userId,
      jobName: meta.jobName,
      payloadSummary: meta.payloadSummary,
      attemptsAllowed: meta.attemptsAllowed,
    });
  }

  async onEnqueueFailed(
    jobId: string,
    error: Error,
    meta: Omit<EnqueuedJobMeta, 'payloadSummary'>
  ): Promise<void> {
    await this.repo.markFailed(jobId, error.message, {
      attemptsMade: 0,
      attemptsAllowed: meta.attemptsAllowed,
    });
  }
}

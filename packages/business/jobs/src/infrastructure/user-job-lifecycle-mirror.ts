import { UserJobRepository } from '@scani/domain/repositories';
import { LIFECYCLE_MIRROR, type LifecycleEvent, type LifecycleMirror } from '@scani/queue';
import { Container, Service } from 'typedi';

// Persists every lifecycle transition into the user_jobs row so the
// /jobs UI sees durable progress / completion / failure even when the
// WS subscriber wasn't connected at the time. WS publish is best-effort
// (live updates); the durable record is here.
@Service({ id: LIFECYCLE_MIRROR })
export class UserJobLifecycleMirror implements LifecycleMirror {
  private readonly repo = Container.get(UserJobRepository);

  // Replaces BullMQ v6's removed `Job#discard()`. See the note on
  // `LifecycleMirror.isCancelled`.
  async isCancelled(jobId: string): Promise<boolean> {
    return this.repo.isCancelled(jobId);
  }

  async onLifecycle(event: LifecycleEvent): Promise<void> {
    switch (event.type) {
      case 'active':
        await this.repo.markActive(event.jobId, event.attemptsMade);
        return;
      case 'progress':
        await this.repo.updateProgress(event.jobId, event.progress);
        return;
      case 'completed':
        await this.repo.markCompleted(event.jobId, event.result);
        return;
      case 'failed':
        await this.repo.markFailed(event.jobId, event.error, {
          attemptsMade: event.attemptsMade,
          attemptsAllowed: event.attemptsAllowed,
          userFacingError: event.userFacingError,
        });
        return;
      // The queue has stopped trying (SC-153). `failed` above fires on every
      // attempt and cannot say that; this fires once, from BullMQ's own
      // terminal event, and it is the only write that reaches a job whose
      // payload never passed validation — that path throws before any other
      // lifecycle event exists.
      case 'dead':
        await this.repo.markDead(event.jobId, {
          reason: event.reason,
          error: event.error,
          userFacingError: event.userFacingError,
          attemptsMade: event.attemptsMade,
          attemptsAllowed: event.attemptsAllowed,
        });
        return;
    }
  }
}

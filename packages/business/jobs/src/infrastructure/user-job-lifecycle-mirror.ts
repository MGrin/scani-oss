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
        });
        return;
    }
  }
}

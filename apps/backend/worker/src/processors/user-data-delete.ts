import { DeleteAccountUseCase, DeleteAllUserDataUseCase } from '@scani/domain/use-cases';
import { USER_DATA_DELETE, type UserDataDeleteJob } from '@scani/jobs';
import { captureException } from '@scani/logging/sentry';
import { type ProcessorContext, UserJobProcessor, userFacing } from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import { Container, Service } from 'typedi';

@Service()
export class UserDataDeleteProcessor extends UserJobProcessor<UserDataDeleteJob, unknown> {
  readonly descriptor = USER_DATA_DELETE;

  protected async handle(data: UserDataDeleteJob, _ctx: ProcessorContext): Promise<unknown> {
    const result = data.deleteAccount
      ? await this.deleteAccount(data.userId)
      : await Container.get(DeleteAllUserDataUseCase).execute(data.userId);
    emitEntityChange({
      entityType: 'user',
      operationType: 'delete',
      entityId: data.userId,
      userId: data.userId,
    });
    return result;
  }

  // The one refusal is an attribution the product keeps (a global price edit);
  // without `userFacing` the browser would toast "Unknown error" over it.
  private async deleteAccount(userId: string) {
    try {
      return await Container.get(DeleteAccountUseCase).execute(userId);
    } catch (err) {
      // The owner was signed out when this was queued and believes the account
      // is gone; the notice on their next sign-in is not an operator signal.
      this.capture(err, {
        component: 'worker',
        job: 'account-delete',
        kind: 'account-delete-failed',
        userId,
      });
      throw userFacing(
        new Error(
          'Your account could not be deleted automatically. Contact support and we will remove it.',
          { cause: err }
        )
      );
    }
  }

  /** Overridden in tests; `captureException` itself never throws. */
  protected capture(err: unknown, tags: Record<string, string>): void {
    captureException(err, tags);
  }
}

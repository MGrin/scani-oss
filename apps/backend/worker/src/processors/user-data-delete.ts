import { DeleteAllUserDataUseCase } from '@scani/domain/use-cases';
import { USER_DATA_DELETE, type UserDataDeleteJob } from '@scani/jobs';
import { type ProcessorContext, UserJobProcessor } from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import { Container, Service } from 'typedi';

@Service()
export class UserDataDeleteProcessor extends UserJobProcessor<UserDataDeleteJob, unknown> {
  readonly descriptor = USER_DATA_DELETE;

  protected async handle(data: UserDataDeleteJob, _ctx: ProcessorContext): Promise<unknown> {
    const result = await Container.get(DeleteAllUserDataUseCase).execute(data.userId);
    emitEntityChange({
      entityType: 'user',
      operationType: 'delete',
      entityId: data.userId,
      userId: data.userId,
    });
    return result;
  }
}

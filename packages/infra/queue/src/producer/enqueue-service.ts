import type { JobsOptions } from 'bullmq';
import type { UserJobDescriptor } from '../core/job-descriptor';
import type { UserJobBase } from '../core/types';

// Producer-side contract. Concrete impl is BullMqEnqueueService;
// tests stub by extending this directly.
export abstract class EnqueueService {
  abstract add<TPayload extends UserJobBase, TResult>(
    descriptor: UserJobDescriptor<TPayload, TResult>,
    data: TPayload,
    overrides?: JobsOptions
  ): Promise<string>;
}

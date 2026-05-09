import { createComponentLogger } from '@scani/logging';
import type { JobsOptions } from 'bullmq';
import { Container, Service } from 'typedi';
import type { UserJobDescriptor } from '../core/job-descriptor';
import type { UserJobBase } from '../core/types';
import { ENQUEUE_MIRROR, type EnqueueMirror } from './enqueue-mirror';
import { EnqueueService } from './enqueue-service';
import { QueueClient } from './queue-client';

const logger = createComponentLogger('queue:enqueue');

@Service()
export class BullMqEnqueueService extends EnqueueService {
  private readonly queueClient = Container.get(QueueClient);

  override async add<TPayload extends UserJobBase, TResult>(
    descriptor: UserJobDescriptor<TPayload, TResult>,
    data: TPayload,
    overrides?: JobsOptions
  ): Promise<string> {
    const jobId = descriptor.computeJobId(data);
    const opts: JobsOptions = {
      jobId,
      ...descriptor.defaultOpts,
      ...overrides,
    };
    const attemptsAllowed = (opts.attempts as number | undefined) ?? 1;
    const mirror = this.tryGetMirror();

    if (mirror) {
      await mirror.onEnqueued({
        jobId,
        userId: data.userId,
        jobName: descriptor.name,
        payloadSummary: descriptor.summarizePayload(data),
        attemptsAllowed,
      });
    }

    try {
      await this.queueClient.get().add(descriptor.name, data, opts);
      logger.info(
        { jobId, jobName: descriptor.name, userId: data.userId, attemptsAllowed },
        'Job enqueued'
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(
        {
          jobId,
          jobName: descriptor.name,
          userId: data.userId,
          err: error.message,
        },
        'Job enqueue failed'
      );
      if (mirror) {
        await mirror.onEnqueueFailed(jobId, error, {
          jobId,
          userId: data.userId,
          jobName: descriptor.name,
          attemptsAllowed,
        });
      }
      throw err;
    }
    return jobId;
  }

  // Optional mirror — domain wires one in cloud/managed deploys; OSS
  // and tests can skip. typedi throws on missing tokens, so we swallow.
  private tryGetMirror(): EnqueueMirror | null {
    try {
      return Container.get(ENQUEUE_MIRROR);
    } catch {
      return null;
    }
  }
}

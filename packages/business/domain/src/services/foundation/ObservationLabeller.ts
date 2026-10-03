import type { DatabaseTransaction } from '@scani/db';
import { Container, Service } from 'typedi';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import { classifyHoldingEvidence } from './legacy-classification';

/**
 * Labels one observation as it is written, so a writer leaves nothing for the
 * backfill to fill (D-5).
 */
@Service()
export class ObservationLabeller {
  private readonly evidence = Container.get(EngineEvidenceRepository);

  /**
   * The labels A1's classifier gives the observation, read with the holding's
   * rows as they stand in `tx` rather than restated, so they are the ones the
   * backfill derives. Only the columns still NULL are written (D-4).
   */
  async labelAsClassified(
    userId: string,
    holdingId: string,
    observationId: string,
    tx: DatabaseTransaction
  ): Promise<void> {
    const [raw] = await this.evidence.findHoldingEvidence({ userId, holdingIds: [holdingId] }, tx);
    if (raw === undefined) return;
    const { labels } = classifyHoldingEvidence(raw);
    await this.evidence.fillMissingLabels(
      userId,
      [
        {
          holdingId,
          holding: {},
          observations: labels.observations.filter((label) => label.id === observationId),
          entries: [],
        },
      ],
      tx
    );
  }
}

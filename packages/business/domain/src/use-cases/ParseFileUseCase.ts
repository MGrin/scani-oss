import type { CsvColumnMapping } from '@scani/file-import';
import { parseStatement } from '@scani/file-import';
import { createComponentLogger } from '@scani/logging';
import Container, { Service } from 'typedi';
import { CsvColumnDetectionService, EnrichHoldingsService } from '../services';
import type { EnrichedParsedHolding } from '../services/holdings/EnrichHoldingsService';

export type { EnrichedParsedHolding };

const logger = createComponentLogger('use-case:parse-file');

export interface ParseFileInput {
  /** File content: decoded text for CSV/OFX/QIF, base64 for PDF */
  content: string;
  filename: string;
  bankTemplate?: string;
  customMapping?: CsvColumnMapping;
  accountId?: string;
  userId: string;
}

export interface ParseFileResult {
  holdings: EnrichedParsedHolding[];
  format: string;
  warnings: string[];
}

/**
 * Use case for parsing bank statement files and enriching extracted holdings.
 * Orchestrates: parseStatement() → ExtractedHolding[] → EnrichHoldingsUseCase → EnrichedParsedHolding[]
 */
@Service()
export class ParseFileUseCase {
  private readonly enrichHoldingsService = Container.get(EnrichHoldingsService);
  private readonly csvColumnDetectionService = Container.get(CsvColumnDetectionService);

  async execute(input: ParseFileInput): Promise<ParseFileResult> {
    logger.info(
      { filename: input.filename, bankTemplate: input.bankTemplate, accountId: input.accountId },
      'Starting file parsing and enrichment'
    );

    const result = await parseStatement(input.content, input.filename, {
      bankTemplate: input.bankTemplate,
      customMapping: input.customMapping,
      aiColumnDetector: (headers, sampleRows) =>
        this.csvColumnDetectionService.detectColumns(headers, sampleRows),
    });

    logger.info(
      {
        format: result.format,
        transactionCount: result.transactions.length,
        holdingCount: result.holdings.length,
        warnings: result.warnings.length,
      },
      'File parsed, enriching holdings'
    );

    if (result.holdings.length === 0) {
      return {
        holdings: [],
        format: result.format,
        warnings: result.warnings,
      };
    }

    const enrichedHoldings = await this.enrichHoldingsService.enrich({
      holdings: result.holdings,
      accountId: input.accountId,
      userId: input.userId,
    });

    logger.info(
      {
        enrichedCount: enrichedHoldings.length,
        withTokenId: enrichedHoldings.filter((h) => h.tokenId).length,
      },
      'File parsing and enrichment completed'
    );

    return {
      holdings: enrichedHoldings,
      format: result.format,
      warnings: result.warnings,
    };
  }
}

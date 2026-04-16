import Container, { Service } from 'typedi';
import type { CsvColumnMapping } from '../external-services/file-import';
import { parseStatement } from '../external-services/file-import';
import { createComponentLogger } from '../utils/logger';
import type { EnrichedParsedHolding } from './EnrichHoldingsUseCase';
import { EnrichHoldingsUseCase } from './EnrichHoldingsUseCase';

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
  private readonly enrichHoldingsUseCase = Container.get(EnrichHoldingsUseCase);

  async execute(input: ParseFileInput): Promise<ParseFileResult> {
    logger.info(
      { filename: input.filename, bankTemplate: input.bankTemplate, accountId: input.accountId },
      'Starting file parsing and enrichment'
    );

    // Parse the file to extract holdings
    const result = await parseStatement(
      input.content,
      input.filename,
      input.bankTemplate,
      input.customMapping
    );

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

    // Enrich holdings with token/holding IDs
    const enrichedHoldings = await this.enrichHoldingsUseCase.execute({
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

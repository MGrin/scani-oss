import { createComponentLogger } from '@scani/logging';
// pdf-parse's top-level index.js runs a self-test that reads a bundled
// PDF — that breaks under bundling. Import the internal impl directly
// to bypass the self-test. See https://gitlab.com/autokent/pdf-parse/-/issues/24.
// @ts-expect-error — no published types for the internal subpath; the
// default export is `(buffer: Buffer) => Promise<{ text: string }>`.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import Container, { Service } from 'typedi';
import { AIService } from '../services/AIService';
import type { EnrichedParsedHolding } from './EnrichHoldingsUseCase';
import { EnrichHoldingsUseCase } from './EnrichHoldingsUseCase';

const logger = createComponentLogger('use-case:parse-screenshot');

export type { EnrichedParsedHolding };

export interface ParseScreenshotInput {
  imageBase64: string;
  mimeType?: string;
  provider?: 'openai' | 'perplexity' | 'deepseek';
  accountType?: string;
  expectedCurrency?: string;
  context?: string;
  minConfidence?: number;
  accountId?: string;
  userId: string;
}

export interface ParseScreenshotResult {
  holdings: EnrichedParsedHolding[];
  overallConfidence: number;
  context?: string;
  detectedCurrency?: string;
}

/**
 * Use case for parsing screenshots and enriching holdings with database token IDs
 */
@Service()
export class ParseScreenshotUseCase {
  private readonly aiService = Container.get(AIService);
  private readonly enrichHoldingsUseCase = Container.get(EnrichHoldingsUseCase);

  async execute(input: ParseScreenshotInput): Promise<ParseScreenshotResult> {
    logger.info(
      {
        provider: input.provider,
        accountType: input.accountType,
        expectedCurrency: input.expectedCurrency,
        accountId: input.accountId,
        userId: input.userId,
      },
      'Starting screenshot parsing and token enrichment'
    );

    // PDFs don't round-trip through the vision Chat Completions API
    // (OpenAI + DeepSeek + Perplexity all reject `application/pdf` in
    // `image_url` → 400). Extract text with pdf-parse and go through
    // the text completion path instead. Most financial statements are
    // digitally generated and have embedded text, so this works for
    // the overwhelming majority of real uploads. Scanned / image-only
    // PDFs still fail with a "couldn't parse" message — those need
    // OCR which isn't worth the dependency weight right now.
    const isPdf = input.mimeType === 'application/pdf';
    const portfolio = isPdf
      ? await this.parsePdfText(input)
      : await this.aiService.parseScreenshot(input.imageBase64, {
          provider: input.provider,
          accountType: input.accountType,
          expectedCurrency: input.expectedCurrency,
          context: input.context,
          minConfidence: input.minConfidence,
          mimeType: input.mimeType,
        });

    logger.info(
      {
        holdingsCount: portfolio.holdings.length,
        overallConfidence: portfolio.overallConfidence,
      },
      'AI parsing completed, enriching with token and holding data'
    );

    // Enrich holdings with token IDs and existing holding IDs
    const enrichedHoldings = await this.enrichHoldingsUseCase.execute({
      holdings: portfolio.holdings,
      accountId: input.accountId,
      userId: input.userId,
    });

    const result: ParseScreenshotResult = {
      holdings: enrichedHoldings,
      overallConfidence: portfolio.overallConfidence,
      context: portfolio.context,
      detectedCurrency: portfolio.detectedCurrency,
    };

    logger.info(
      {
        enrichedHoldingsCount: enrichedHoldings.length,
        holdingsWithTokenId: enrichedHoldings.filter((h) => h.tokenId).length,
        holdingsWithHoldingId: enrichedHoldings.filter((h) => h.holdingId).length,
      },
      'Screenshot parsing and enrichment completed'
    );

    return result;
  }

  private async parsePdfText(input: ParseScreenshotInput) {
    const pdfBuffer = Buffer.from(input.imageBase64, 'base64');
    let text = '';
    try {
      const parsed = await pdfParse(pdfBuffer);
      text = (parsed.text ?? '').trim();
    } catch (error) {
      // Pass structured `err` + plain `reason` so the logger catches both
      // ways (the pretty-printer treats `error` as {name,message} but
      // accepts any extra fields verbatim).
      const reason = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          err: error instanceof Error ? { name: error.name, message: error.message } : error,
          reason,
          bufferSize: pdfBuffer.length,
        },
        'pdf-parse failed'
      );
      throw new Error(
        `We couldn't read text from this PDF (${reason}). If it's scanned, image-only, or password-protected, export a CSV/OFX from your provider instead.`
      );
    }
    if (!text) {
      throw new Error(
        'This PDF appears to be image-only (scanned). Please upload a text PDF or export a CSV/OFX from your provider.'
      );
    }
    logger.info({ textLength: text.length }, 'Extracted PDF text, sending to AI');
    return this.aiService.parseDocumentText(text, {
      provider: input.provider,
      accountType: input.accountType,
      expectedCurrency: input.expectedCurrency,
      context: input.context,
      minConfidence: input.minConfidence,
    });
  }
}

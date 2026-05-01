import { createComponentLogger } from '@scani/logging';
import Container, { Service } from 'typedi';
// `unpdf` ships pdfjs-dist as a static import, so it survives
// `bun build --compile` (the previous `pdf-parse` dependency did
// `require(\`./pdf.js/v\${VERSION}/build/pdf.js\`)`, which the bundler
// couldn't statically resolve — at runtime the binary then failed
// with "Cannot find module './pdf.js/v1.10.100/build/pdf.js'").
import { extractText, getDocumentProxy } from 'unpdf';
import { EnrichHoldingsService, ScreenshotParsingService } from '../services';
import type { EnrichedParsedHolding } from '../services/holdings/EnrichHoldingsService';

const logger = createComponentLogger('use-case:parse-screenshot');

export type { EnrichedParsedHolding };

export interface ParseScreenshotInput {
  imageBase64: string;
  mimeType?: string;
  provider?: 'openai';
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
  private readonly screenshotService = Container.get(ScreenshotParsingService);
  private readonly enrichHoldingsService = Container.get(EnrichHoldingsService);

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
      : await this.screenshotService.parseScreenshot(input.imageBase64, {
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
    const enrichedHoldings = await this.enrichHoldingsService.enrich({
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
      const doc = await getDocumentProxy(new Uint8Array(pdfBuffer));
      const extracted = await extractText(doc, { mergePages: true });
      text = extracted.text.trim();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          err: error instanceof Error ? { name: error.name, message: error.message } : error,
          reason,
          bufferSize: pdfBuffer.length,
        },
        'pdf text extraction failed'
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
    return this.screenshotService.parseDocumentText(text, {
      provider: input.provider,
      accountType: input.accountType,
      expectedCurrency: input.expectedCurrency,
      context: input.context,
      minConfidence: input.minConfidence,
    });
  }
}

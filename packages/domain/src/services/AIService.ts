import type { ParsedPortfolio } from '@scani/ai-providers';
import { Container, Service } from 'typedi';
import { AIProviderService } from './AIProviderService';
import { BaseService } from './BaseService';
import { CsvColumnDetectionService } from './CsvColumnDetectionService';
import { ScreenshotParsingService } from './ScreenshotParsingService';

/**
 * Back-compat facade over the split AI services — callers that still
 * import `AIService` continue to work, but the underlying responsibilities
 * live in three focused services now:
 *
 *  - `AIProviderService` owns the `AIProviderManager` wiring + provider
 *    status reporting.
 *  - `CsvColumnDetectionService` handles CSV-column-mapping inference.
 *  - `ScreenshotParsingService` handles portfolio extraction from images.
 *
 * New call sites should depend on the specific service they need.
 */
@Service()
export class AIService extends BaseService {
  private readonly providerService = Container.get(AIProviderService);
  private readonly csvService = Container.get(CsvColumnDetectionService);
  private readonly screenshotService = Container.get(ScreenshotParsingService);

  constructor() {
    super('AIService');
  }

  async detectCsvColumns(
    headers: string[],
    sampleRows: Record<string, string>[]
  ): Promise<Record<string, string> | null> {
    return this.csvService.detectColumns(headers, sampleRows);
  }

  async parseScreenshot(
    imageBase64: string,
    options?: {
      provider?: 'openai' | 'perplexity' | 'deepseek';
      accountType?: string;
      expectedCurrency?: string;
      context?: string;
      minConfidence?: number;
      mimeType?: string;
    }
  ): Promise<ParsedPortfolio> {
    return this.screenshotService.parseScreenshot(imageBase64, options);
  }

  async parseDocumentText(
    text: string,
    options?: {
      provider?: 'openai' | 'perplexity' | 'deepseek';
      accountType?: string;
      expectedCurrency?: string;
      context?: string;
      minConfidence?: number;
    }
  ): Promise<ParsedPortfolio> {
    return this.screenshotService.parseDocumentText(text, options);
  }

  getProviderStatus() {
    return this.providerService.getStatus();
  }
}

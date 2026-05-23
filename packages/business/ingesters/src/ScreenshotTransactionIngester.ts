import type { NewHoldingBalanceObservation, NewHoldingTransaction } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';

export interface ScreenshotIngesterInput {
  userId: string;
  accountId: string;
  imageBase64: string;
  mimeType: string;
  resolveFiatTokenBySymbol: (symbol: string) => Promise<{ tokenId: string } | null>;
}

export interface ScreenshotIngesterResult {
  transactions: NewHoldingTransaction[];
  observations: NewHoldingBalanceObservation[];
  warnings: string[];
  firstEventAt: Date | null;
  lastEventAt: Date | null;
}

export interface ScreenshotParserOptions {
  accountType?: string;
  expectedCurrency?: string;
  context?: string;
  minConfidence?: number;
  mimeType?: string;
}

export interface ScreenshotParserHolding {
  symbol?: string;
  name?: string;
  quantity?: number | string;
  currency?: string;
  confidence: number;
}

export interface ScreenshotParserResult {
  holdings: ScreenshotParserHolding[];
  overallConfidence: number;
  context?: string;
  detectedCurrency?: string;
}

export type ScreenshotParserFn = (
  imageBase64: string,
  options?: ScreenshotParserOptions
) => Promise<ScreenshotParserResult>;

export class ScreenshotTransactionIngester {
  private readonly logger = createComponentLogger('ingester:screenshot');

  readonly source = 'screenshot';

  constructor(private readonly parseScreenshot: ScreenshotParserFn) {}

  async ingest(_input: ScreenshotIngesterInput): Promise<ScreenshotIngesterResult> {
    this.logger.info(
      {
        source: this.source,
        hasParser: typeof this.parseScreenshot === 'function',
      },
      'ScreenshotTransactionIngester registered; AI tx-extraction prompt pending'
    );
    return {
      transactions: [],
      observations: [],
      warnings: [],
      firstEventAt: null,
      lastEventAt: null,
    };
  }
}

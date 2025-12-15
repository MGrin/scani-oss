export type Step = 'method' | 'binanceAuth' | 'krakenAuth' | 'account' | 'data';

export type CompleteImportData = {
  // Method selection data
  method?: 'manual' | 'screenshots' | 'wallet' | 'binance' | 'kraken';

  // Account selection data
  accountSelection?: {
    mode: 'select' | 'create';
    selectedAccountId?: string;
    newAccountData?: {
      name: string;
      typeId: string;
      institutionSelection?: {
        mode: 'select' | 'create';
        selectedInstitutionId?: string;
        newInstitutionData?: {
          name: string;
          typeId: string;
          website: string;
          description: string;
        };
      };
    };
  };

  // Data entry data (for future use)
  dataEntry?: {
    holdings?: Array<{
      id: string;
      tokenValue: string;
      amount: string;
      isExisting?: boolean; // New field to distinguish existing vs new holdings
      originalAmount?: string; // Track original amount for change detection
      holdingId?: string;
    }>;
  };
};

export interface EnrichedParsedHolding {
  symbol: string;
  name?: string;
  balance: string;
  confidence: number;
  notes?: string;
  tokenId?: string;
  holdingId?: string;
  existingBalance?: string;
}

export interface ParseScreenshotResult {
  holdings: EnrichedParsedHolding[];
  overallConfidence: number;
  context?: string;
  detectedCurrency?: string;
}

export interface ScreenshotParseResult {
  filename: string;
  success: boolean;
  data?: ParseScreenshotResult;
  error?: string;
  processingTime: number;
}

export interface ScreenshotParseSummary {
  totalFiles: number;
  successCount: number;
  failureCount: number;
  totalProcessingTime: number;
  averageProcessingTime: number;
}

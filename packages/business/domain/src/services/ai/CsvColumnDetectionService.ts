import { Container, Service } from 'typedi';
import { BaseService } from '../BaseService';
import { AIRouter } from './AIRouter';

// AI-driven CSV column mapping — sends headers + 2 sample rows and asks
// the LLM to guess which column is `date`, `amount`, `balance`, etc.
// Minimal token cost, fallback-across-providers built in.
@Service()
export class CsvColumnDetectionService extends BaseService {
  private readonly aiRouter = Container.get(AIRouter);

  constructor() {
    super('CsvColumnDetectionService');
  }

  async detectColumns(
    headers: string[],
    sampleRows: Record<string, string>[]
  ): Promise<Record<string, string> | null> {
    if (!this.aiRouter.hasAvailableProvider()) {
      this.logWarning('No AI provider available for CSV column detection');
      return null;
    }

    const samples = sampleRows.slice(0, 2);
    const sampleText = samples
      .map((row, i) => {
        const vals = headers.map((h) => `${h}: ${row[h] || ''}`).join(', ');
        return `Row ${i + 1}: ${vals}`;
      })
      .join('\n');

    const prompt = `CSV columns: ${headers.join(', ')}

${sampleText}

Map these CSV columns to financial fields. Reply with ONLY a JSON object using the exact original column names as values:
{"date":"","description":"","amount":"","credit":"","debit":"","currency":"","balance":""}

Rules:
- Use the EXACT column name from the CSV (case-sensitive)
- Set empty string "" for fields that don't exist
- "amount" = single column with transaction amount (positive/negative)
- "credit"/"debit" = separate columns for money in/out (use INSTEAD of amount)
- "balance" = running/closing account balance
- Only use column names that exist in the CSV`;

    try {
      const result = await this.aiRouter.completeText(prompt, {
        maxTokens: 150,
        temperature: 0,
        jsonMode: true,
        fallbackProviders: true,
      });

      // Extract JSON from response (handle markdown code blocks)
      let content = result.content.trim();
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (jsonMatch) {
        content = jsonMatch[1] ?? '';
      }

      const parsed = JSON.parse(content) as Record<string, string>;
      this.logDebug('AI detected CSV columns', { mapping: parsed, provider: result.provider });

      // Validate column names exist in headers
      const headerSet = new Set(headers);
      const validated: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (value && headerSet.has(value)) {
          validated[key] = value;
        }
      }

      return Object.keys(validated).length > 0 ? validated : null;
    } catch (error) {
      this.logWarning('AI CSV column detection failed', {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }
}

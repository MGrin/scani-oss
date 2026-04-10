import { createComponentLogger } from '../../utils/logger';
import type { CsvColumnMapping } from './types';

const logger = createComponentLogger('ai-csv-mapper');

/**
 * Use AI (OpenAI) to detect CSV column mapping from headers and sample data.
 * This is a lightweight text-only call — no images, minimal tokens.
 * Only called when auto-detection fails to find key columns (especially balance).
 *
 * Cost: ~200 input tokens + ~100 output tokens ≈ $0.001 per call
 */
export async function detectCsvColumnsWithAI(
  headers: string[],
  sampleRows: Record<string, string>[],
  apiKey?: string
): Promise<Partial<CsvColumnMapping> | null> {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) {
    logger.warn('OpenAI API key not available for CSV column detection');
    return null;
  }

  // Build minimal context: headers + 2 sample rows
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
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 150,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'AI CSV column detection failed');
      return null;
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as Record<string, string>;
    logger.info({ mapping: parsed }, 'AI detected CSV column mapping');

    // Validate that mapped column names actually exist in headers
    const headerSet = new Set(headers);
    const result: Partial<CsvColumnMapping> = {};

    if (parsed.date && headerSet.has(parsed.date)) result.date = parsed.date;
    if (parsed.description && headerSet.has(parsed.description))
      result.description = parsed.description;
    if (parsed.amount && headerSet.has(parsed.amount)) result.amount = parsed.amount;
    if (parsed.credit && headerSet.has(parsed.credit)) result.credit = parsed.credit;
    if (parsed.debit && headerSet.has(parsed.debit)) result.debit = parsed.debit;
    if (parsed.currency && headerSet.has(parsed.currency)) result.currency = parsed.currency;
    if (parsed.balance && headerSet.has(parsed.balance)) result.balance = parsed.balance;

    return result;
  } catch (error) {
    logger.warn({ error }, 'AI CSV column detection error');
    return null;
  }
}

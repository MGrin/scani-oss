import { tinkoffRateLimiter } from '../rate-limiters/tinkoff';
import { TinkoffApiService } from '../services/TinkoffApiService';

export function createTinkoffApiService(): TinkoffApiService {
  const baseUrl = process.env.TINKOFF_API_BASE_URL || 'https://invest-public-api.tinkoff.ru';
  return new TinkoffApiService(baseUrl, tinkoffRateLimiter);
}

export async function validateTinkoffCredentials(apiToken: string): Promise<boolean> {
  return await createTinkoffApiService().validateToken(apiToken);
}

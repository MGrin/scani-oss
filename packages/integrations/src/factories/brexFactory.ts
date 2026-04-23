import { brexRateLimiter } from '../rate-limiters/brex';
import { BrexApiService } from '../services/BrexApiService';

export function createBrexApiService(): BrexApiService {
  const baseUrl = process.env.BREX_API_BASE_URL || 'https://platform.brexapis.com';
  return new BrexApiService(baseUrl, brexRateLimiter);
}

export async function validateBrexCredentials(apiToken: string): Promise<boolean> {
  return await createBrexApiService().validateToken(apiToken);
}

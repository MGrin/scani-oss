import { mercuryRateLimiter } from '../rate-limiters/mercury';
import { MercuryApiService } from '../services/MercuryApiService';

export function createMercuryApiService(): MercuryApiService {
  const baseUrl = process.env.MERCURY_API_BASE_URL || 'https://backend.mercury.com/api/v1';
  return new MercuryApiService(baseUrl, mercuryRateLimiter);
}

export async function validateMercuryCredentials(apiToken: string): Promise<boolean> {
  return await createMercuryApiService().validateToken(apiToken);
}

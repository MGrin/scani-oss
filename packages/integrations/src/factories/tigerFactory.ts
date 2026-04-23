import { tigerRateLimiter } from '../rate-limiters/tiger';
import { TigerApiService } from '../services/TigerApiService';

export function createTigerApiService(): TigerApiService {
  const baseUrl = process.env.TIGER_API_BASE_URL || 'https://openapi.tigerfintech.com';
  return new TigerApiService(baseUrl, tigerRateLimiter);
}

export async function validateTigerCredentials(
  tigerId: string,
  privateKeyPem: string
): Promise<boolean> {
  return await createTigerApiService().validateCredentials(tigerId, privateKeyPem);
}

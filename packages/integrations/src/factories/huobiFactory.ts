import { huobiRateLimiter } from '../rate-limiters/huobi';
import { HuobiApiService } from '../services/HuobiApiService';

export function createHuobiApiService(): HuobiApiService {
  return new HuobiApiService('https://api.huobi.pro', huobiRateLimiter);
}

export async function validateHuobiCredentials(
  apiKey: string,
  apiSecret: string
): Promise<boolean> {
  const service = createHuobiApiService();
  return service.validateCredentials(apiKey, apiSecret);
}

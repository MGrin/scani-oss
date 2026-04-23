import { zerodhaRateLimiter } from '../rate-limiters/zerodha';
import { ZerodhaApiService } from '../services/ZerodhaApiService';

export function createZerodhaApiService(): ZerodhaApiService {
  const baseUrl = process.env.ZERODHA_API_BASE_URL || 'https://api.kite.trade';
  return new ZerodhaApiService(baseUrl, zerodhaRateLimiter);
}

/**
 * Validates Kite Connect credentials by attempting the full login →
 * TOTP → session/token flow. If it produces an access_token, all five
 * credential fields are correct.
 */
export async function validateZerodhaCredentials(creds: {
  apiKey: string;
  apiSecret: string;
  userId: string;
  password: string;
  totpSecret: string;
}): Promise<boolean> {
  try {
    await createZerodhaApiService().refreshAccessToken(creds);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('HTTP 40') ||
      msg.includes('TOTP') ||
      msg.includes('request_token') ||
      msg.includes('2FA')
    ) {
      return false;
    }
    throw err;
  }
}

import { proxyJobAction } from '../_proxy';

export const runtime = 'edge';

export async function POST(request: Request): Promise<Response> {
  return proxyJobAction(request, 'retry');
}

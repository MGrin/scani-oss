/**
 * The push services browsers actually issue subscriptions for: Chrome and
 * Edge (FCM), Firefox (Mozilla autopush), Safari (Apple) and legacy Edge
 * (WNS, one host per region). An endpoint is a URL the api and worker POST to,
 * so anything wider lets a caller aim those requests at a host of their
 * choosing, including the private network (SC-1346).
 */
const EXACT_HOSTS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);
const HOST_SUFFIXES = ['.notify.windows.com'];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

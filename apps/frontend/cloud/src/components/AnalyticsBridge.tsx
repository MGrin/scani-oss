import { useAnalyticsIdentify, useCapturePageview } from '@scani/analytics/client';
import { useLocation } from 'react-router-dom';
import { authClient } from '../lib/auth-client';

// Bridges router + auth state into PostHog: a $pageview on every route
// change and identify/reset as the user signs in and out. Renders nothing.
export function AnalyticsBridge() {
  const location = useLocation();
  const { data } = authClient.useSession();
  useCapturePageview(location.pathname + location.search);
  useAnalyticsIdentify(data?.user ?? null);
  return null;
}

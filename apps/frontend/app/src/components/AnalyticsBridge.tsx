import { useAnalyticsIdentify, useCapturePageview } from '@scani/analytics/client';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';

// Bridges router + auth state into PostHog: a $pageview on every route
// change and identify/reset as the user signs in and out. Renders nothing.
export function AnalyticsBridge() {
  const location = useLocation();
  const { user } = useAuth();
  useCapturePageview(location.pathname + location.search);
  useAnalyticsIdentify(user);
  return null;
}

import { Redirect } from 'expo-router';
import { useEffect } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { useAppLoader } from '@/utils/appLoaderContext';

export default function Index() {
  const { session, loading } = useAuth();
  const { dismissLoader } = useAppLoader();

  useEffect(() => {
    if (!loading) {
      dismissLoader();
    }
  }, [loading, dismissLoader]);

  if (loading) {
    return null;
  }

  if (session) {
    return <Redirect href="/(app)" />;
  }

  return <Redirect href="/(auth)" />;
}

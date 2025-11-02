import { Redirect } from 'expo-router';
import type { ViewStyle } from 'react-native';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '@/contexts/AuthContext';
import { useAppTheme } from '@/theme/context';
import type { ThemedStyle } from '@/theme/types';

export default function Index() {
  const { session, loading } = useAuth();
  const { themed, theme } = useAppTheme();

  if (loading) {
    return (
      <View style={themed($loadingContainer)}>
        <ActivityIndicator size="large" color={theme.colors.tint} />
      </View>
    );
  }

  if (session) {
    return <Redirect href="/(app)" />;
  }

  return <Redirect href="/(auth)" />;
}

const $loadingContainer: ThemedStyle<ViewStyle> = ({ colors }) => ({
  flex: 1,
  justifyContent: 'center',
  alignItems: 'center',
  backgroundColor: colors.background,
});

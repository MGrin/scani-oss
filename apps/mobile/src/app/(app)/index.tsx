import { format } from 'date-fns';
import { type FC, useState } from 'react';
import { Alert, type TextStyle, View, type ViewStyle } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { Text } from '@/components/Text';
import { useAuth } from '@/contexts/AuthContext';
import { translate } from '@/i18n';
import { useAppTheme } from '@/theme/context';
import type { ThemedStyle } from '@/theme/types';
import { logger } from '@/utils/logger';

const HomeScreen: FC = () => {
  const { themed } = useAppTheme();
  const { user, signOut } = useAuth();
  const [isSigningOut, setIsSigningOut] = useState(false);

  const handleSignOut = () => {
    Alert.alert(translate('home:signOut'), translate('home:confirmSignOut'), [
      {
        text: translate('common:cancel'),
        style: 'cancel',
      },
      {
        text: translate('home:signOut'),
        style: 'destructive',
        onPress: async () => {
          try {
            setIsSigningOut(true);
            logger.info('User initiated sign out', { userId: user?.id });
            await signOut();
          } catch (error) {
            logger.error('Sign out failed', error as Error);
            setIsSigningOut(false);
          }
        },
      },
    ]);
  };

  const memberSince = user?.created_at ? format(new Date(user.created_at), 'MMMM yyyy') : '-';

  return (
    <Screen preset="fixed" contentContainerStyle={themed($container)} safeAreaEdges={['top']}>
      <Animated.View entering={FadeIn.duration(600)} style={themed($content)}>
        <Text preset="heading" tx="home:title" style={themed($title)} />

        <View style={themed($infoCard)}>
          <View style={themed($infoRow)}>
            <Text tx="home:signedInAs" style={themed($label)} />
            <Text style={themed($value)}>{user?.email}</Text>
          </View>

          {__DEV__ && (
            <View style={themed($infoRow)}>
              <Text tx="home:userId" style={themed($label)} />
              <Text style={themed($value)}>{user?.id}</Text>
            </View>
          )}

          <View style={themed($infoRow)}>
            <Text tx="home:memberSince" style={themed($label)} />
            <Text style={themed($value)}>{memberSince}</Text>
          </View>
        </View>

        <Button
          preset="default"
          onPress={handleSignOut}
          tx={isSigningOut ? 'home:signingOut' : 'home:signOut'}
          disabled={isSigningOut}
          style={themed($signOutButton)}
        />
      </Animated.View>
    </Screen>
  );
};

const $container: ThemedStyle<ViewStyle> = ({ colors }) => ({
  flex: 1,
  backgroundColor: colors.background,
});

const $content: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flex: 1,
  justifyContent: 'center',
  alignItems: 'center',
  padding: spacing.lg,
});

const $title: ThemedStyle<TextStyle> = ({ colors, spacing, typography }) => ({
  textAlign: 'center',
  color: colors.text,
  fontFamily: typography.primary.semiBold,
  marginBottom: spacing.xl,
});

const $infoCard: ThemedStyle<ViewStyle> = ({ spacing, colors }) => ({
  width: '100%',
  backgroundColor: colors.palette.neutral100,
  borderRadius: 12,
  padding: spacing.lg,
  gap: spacing.md,
  marginBottom: spacing.xl,
});

const $infoRow: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  gap: spacing.xs,
});

const $label: ThemedStyle<TextStyle> = ({ colors, typography }) => ({
  color: colors.textDim,
  fontFamily: typography.primary.normal,
  fontSize: 14,
});

const $value: ThemedStyle<TextStyle> = ({ colors, typography }) => ({
  color: colors.text,
  fontFamily: typography.primary.medium,
  fontSize: 16,
});

const $signOutButton: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  marginTop: spacing.md,
  minWidth: 200,
});

export default HomeScreen;

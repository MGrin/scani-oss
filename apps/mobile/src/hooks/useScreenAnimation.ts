import { useCallback, useEffect, useRef } from 'react';
import { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { timing } from '@/theme/timing';

interface UseScreenAnimationOptions {
  /**
   * Skip animation on initial mount (immediate show)
   * Useful for preventing flash on first load
   */
  skipInitialAnimation?: boolean;
  /**
   * Animation duration in ms
   */
  duration?: number;
}

interface UseScreenAnimationReturn {
  /**
   * Animated style to apply to Animated.View
   */
  animatedStyle: ReturnType<typeof useAnimatedStyle>;
  /**
   * Manually trigger the fade-in animation
   */
  triggerAnimation: () => void;
  /**
   * Reset animation to initial state
   */
  resetAnimation: () => void;
  /**
   * Opacity value (can be used directly if needed)
   */
  opacity: ReturnType<typeof useSharedValue<number>>;
}

/**
 * Standardized screen fade-in animation hook.
 * Handles common animation patterns: fade-in on mount, skip on initial load.
 *
 * @param options - Animation configuration options
 * @returns Animation utilities
 *
 * @example
 * // Simple fade-in
 * const { animatedStyle } = useScreenAnimation()
 * return <Animated.View style={animatedStyle}>...</Animated.View>
 *
 * @example
 * // Skip animation on first mount
 * const { animatedStyle } = useScreenAnimation({ skipInitialAnimation: true })
 */
export function useScreenAnimation(
  options: UseScreenAnimationOptions = {}
): UseScreenAnimationReturn {
  const { skipInitialAnimation = false, duration = timing.quick } = options;

  const opacity = useSharedValue(skipInitialAnimation ? 1 : 0);
  const isInitialMount = useRef(true);

  const triggerAnimation = useCallback(() => {
    const animationConfig = {
      duration,
      easing: Easing.out(Easing.cubic),
    };

    opacity.value = withTiming(1, animationConfig);
  }, [opacity, duration]);

  const resetAnimation = useCallback(() => {
    opacity.value = 0;
  }, [opacity]);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      if (!skipInitialAnimation) {
        // Small delay to ensure component is mounted
        const timeoutId = setTimeout(triggerAnimation, 0);
        return () => clearTimeout(timeoutId);
      }
      return undefined;
    } else {
      // On subsequent renders/refocuses, always animate
      resetAnimation();
      const timeoutId = setTimeout(triggerAnimation, 50);
      return () => clearTimeout(timeoutId);
    }
  }, [skipInitialAnimation, triggerAnimation, resetAnimation]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return {
    animatedStyle,
    triggerAnimation,
    resetAnimation,
    opacity,
  };
}

import type { ViewStyle } from "react-native";
import { useEffect, useState } from "react";
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { SvgIcon } from "@/components/SvgIcon";
import { useAppLoader } from "@/utils/appLoaderContext";

export function AppLoader() {
  const { isLoaderDismissed } = useAppLoader();
  const fadeOutProgress = useSharedValue(0);
  const [isFullyHidden, setIsFullyHidden] = useState(false);

  // Handle fade out when screen is ready
  useEffect(() => {
    if (isLoaderDismissed) {
      fadeOutProgress.value = withTiming(1, { duration: 300 });
    }
  }, [isLoaderDismissed, fadeOutProgress]);

  // Track when fade out is complete
  useAnimatedReaction(
    () => fadeOutProgress.value,
    (progress) => {
      if (progress === 1) {
        runOnJS(setIsFullyHidden)(true);
      }
    },
    []
  );

  const animatedContainerStyle = useAnimatedStyle(() => {
    return {
      opacity: 1 - fadeOutProgress.value,
    };
  });

  // Don't render if fully faded out
  if (isFullyHidden) {
    return null;
  }

  return (
    <Animated.View
      style={[$container, animatedContainerStyle]}
      pointerEvents={isLoaderDismissed ? "none" : "auto"}
    >
      {/* FIXME: Fix magic number (probably by updating splash logo to predictable even number) */}
      <SvgIcon name="scani-icon" size={158} color="#FFFFFF" />
    </Animated.View>
  );
}

const $container: ViewStyle = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  justifyContent: "center",
  alignItems: "center",
  backgroundColor: "#0A1B35",
  zIndex: 9999,
};

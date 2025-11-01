import { FC } from "react"
import { View, ViewStyle, TextStyle, Platform } from "react-native"
import { GlassView } from "expo-glass-effect"

import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

import { Button, ButtonProps } from "./Button"

export interface LiquidGlassButtonProps extends ButtonProps {
  glassStyle?: ViewStyle
}

export const LiquidGlassButton: FC<LiquidGlassButtonProps> = ({ glassStyle, style, textStyle, ...props }) => {
  const { themed } = useAppTheme()

  if (Platform.OS !== "ios") {
    return <Button {...props} style={[themed($androidFallback), style]} textStyle={[themed($whiteText), textStyle]} />
  }

  return (
    <GlassView
      glassEffectStyle="clear"
      isInteractive={false}
      style={[themed($glassContainer), glassStyle]}
    >
      <View style={themed($innerContent)}>
        <Button {...props} style={[themed($button), style]} textStyle={[themed($whiteText), textStyle]} />
      </View>
    </GlassView>
  )
}

const $glassContainer: ThemedStyle<ViewStyle> = () => ({
  width: "100%",
  height: 56,
  borderRadius: 16,
  backgroundColor: "rgba(255, 255, 255, 0.1)",
})

const $innerContent: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  width: "100%",
})

const $button: ThemedStyle<ViewStyle> = () => ({
  backgroundColor: "transparent",
  borderWidth: 0,
  width: "100%",
  minHeight: 0,
  paddingVertical: 0,
  paddingHorizontal: 0,
})

const $whiteText: ThemedStyle<TextStyle> = ({ typography }) => ({
  color: "white",
  fontFamily: typography.primary.medium,
  fontSize: 16,
  lineHeight: 20,
  textAlign: "center",
})

const $androidFallback: ThemedStyle<ViewStyle> = ({ isDark }) => ({
  backgroundColor: isDark ? "rgba(255, 255, 255, 0.15)" : "rgba(255, 255, 255, 0.4)",
  borderWidth: 1,
  borderColor: isDark ? "rgba(255, 255, 255, 0.25)" : "rgba(0, 0, 0, 0.15)",
})


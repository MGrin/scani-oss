import type { FC } from "react"
import { useState, useCallback, useRef, memo, useEffect } from "react"
import { View, Alert, StatusBar, TextInput, Pressable } from "react-native"
import type { ViewStyle, TextStyle } from "react-native"
import { GlassView } from "expo-glass-effect"
import Animated, {
  FadeIn,
  FadeOut,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolateColor,
} from "react-native-reanimated"

import { MagicCodeInput } from "@/components/MagicCodeInput"
import { Screen } from "@/components/Screen"
import { SvgIcon } from "@/components/SvgIcon"
import { Text } from "@/components/Text"
import { useAuth } from "@/contexts/AuthContext"
import { translate } from "@/i18n"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { logger } from "@/utils/logger"

interface EmailInputFormProps {
  email: string
  onChangeText: (text: string) => void
  onSubmit: () => void
  isLoading: boolean
  isEmailValid: boolean
  error: string | null
  inputRef: React.RefObject<TextInput | null>
}

const EmailInputForm: FC<EmailInputFormProps> = memo(
  ({ email, onChangeText, onSubmit, isLoading, isEmailValid, error, inputRef }) => {
    const validationProgress = useSharedValue(0)

    useEffect(() => {
      validationProgress.value = withTiming(isEmailValid ? 1 : 0, {
        duration: 400,
      })
    }, [isEmailValid, validationProgress])

    const animatedButtonStyle = useAnimatedStyle(() => {
      const backgroundColor = interpolateColor(
        validationProgress.value,
        [0, 1],
        ["rgba(255, 255, 255, 0.2)", "#FFFFFF"],
      )

      return {
        backgroundColor,
      }
    })

    const animatedTextStyle = useAnimatedStyle(() => {
      const color = interpolateColor(validationProgress.value, [0, 1], ["#FFFFFF", "#1a1a1a"])

      return {
        color,
      }
    })

    return (
      <>
        <View style={$staticLogoContainer}>
          <SvgIcon name="scani-logo" size={96} />
        </View>

        <Text preset="heading" tx="auth:welcome" style={$staticTitle} />
        <Text tx="auth:enterEmail" style={$staticDescription} />

        <View>
          <Text tx="auth:emailLabel" style={$staticInputLabel} />
          <View style={$staticInputWrapper}>
            <TextInput
              key="email-input-stable"
              ref={inputRef}
              placeholder={translate("auth:emailPlaceholder")}
              placeholderTextColor="rgba(255, 255, 255, 0.5)"
              value={email}
              onChangeText={onChangeText}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              editable={!isLoading}
              style={$staticInput}
              returnKeyType="done"
              onSubmitEditing={onSubmit}
              blurOnSubmit={false}
            />
          </View>
          {error && <Text style={$staticErrorText}>{error}</Text>}
        </View>

        <View style={$staticButtonWrapper}>
          <Animated.View style={[animatedButtonStyle, $staticButtonAnimatedWrapper]}>
            <Pressable
              onPress={onSubmit}
              disabled={isLoading || !isEmailValid}
              style={$staticButtonPressable}
            >
              <Animated.Text style={[animatedTextStyle, $staticButtonText]}>
                {translate("auth:continueWithEmail")}
              </Animated.Text>
            </Pressable>
          </Animated.View>
        </View>

        <Text tx="auth:newAccount" style={$staticHelperText} />
      </>
    )
  },
  (prevProps, nextProps) => {
    return (
      prevProps.email === nextProps.email &&
      prevProps.isLoading === nextProps.isLoading &&
      prevProps.isEmailValid === nextProps.isEmailValid &&
      prevProps.error === nextProps.error
    )
  },
)
EmailInputForm.displayName = "EmailInputForm"

export const LoginScreen: FC = () => {
  const { themed } = useAppTheme()
  const { authenticate, verifyCode } = useAuth()
  const [email, setEmail] = useState("")
  const [isEmailValid, setIsEmailValid] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isEmailSent, setIsEmailSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const emailInputRef = useRef<TextInput>(null)

  const handleEmailSubmit = useCallback(async () => {
    if (!email.trim()) {
      logger.warn("Email submission attempted with empty email")
      Alert.alert("Error", "Please enter your email address")
      return
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      logger.warn("Email validation failed", { email })
      setError("Please enter a valid email address")
      return
    }

    setIsLoading(true)
    setError(null)

    logger.info("Submitting email for authentication", { email })

    const result = await authenticate(email)

    setIsLoading(false)

    if (result.error) {
      logger.error("Email authentication failed", undefined, { email, error: result.error })
      setError(result.error)
    } else {
      logger.info("OTP sent, transitioning to code input", { email })
      setIsEmailSent(true)
    }
  }, [email, authenticate])

  const handleCodeSubmit = useCallback(
    async (code: string) => {
      setError(null)
      logger.info("Submitting verification code", { email })

      const result = await verifyCode(email, code)

      if (result.error) {
        logger.error("Code verification failed", undefined, { email, error: result.error })
        setError(result.error)
        throw new Error(result.error)
      }

      logger.info("Code verified successfully, user authenticated", { email })
    },
    [email, verifyCode],
  )

  const handleResendCode = useCallback(async () => {
    setError(null)
    logger.info("Resending verification code", { email })
    await authenticate(email)
  }, [email, authenticate])

  const handleUseDifferentEmail = useCallback(() => {
    logger.info("User switching to different email")
    setIsEmailSent(false)
    setError(null)
    setEmail("")
  }, [])

  const handleEmailChange = useCallback((text: string) => {
    setEmail(text)
    setError(null)

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    setIsEmailValid(emailRegex.test(text))
  }, [])

  if (isEmailSent) {
    return (
      <View style={themed($container)}>
        <StatusBar barStyle="light-content" />
        <View style={themed($backgroundPattern)}>
          <View style={themed($decorativeCircle1)} />
          <View style={themed($decorativeCircle2)} />
          <View style={themed($decorativeCircle3)} />
        </View>
        <Screen
          preset="fixed"
          contentContainerStyle={themed($screenContainer)}
          safeAreaEdges={["top", "bottom"]}
          backgroundColor="transparent"
        >
          <Animated.View
            entering={FadeIn.duration(600)}
            exiting={FadeOut}
            style={themed($centeredContent)}
          >
            <GlassView glassEffectStyle="clear" isInteractive={false} style={themed($cardGlass)}>
              <View style={themed($cardContent)}>
                <Text preset="heading" tx="auth:checkYourEmail" style={themed($title)} />
                <Text tx="auth:codeSent" style={themed($description)} />
                <Text style={themed($emailDisplay)}>{email}</Text>

                <MagicCodeInput
                  onSubmit={handleCodeSubmit}
                  onResend={handleResendCode}
                  isLoading={isLoading}
                  error={error}
                />

                <GlassView
                  glassEffectStyle="clear"
                  isInteractive={false}
                  style={themed($buttonGlass)}
                >
                  <Pressable onPress={handleUseDifferentEmail} style={themed($buttonPressable)}>
                    <Text tx="auth:useDifferentEmail" style={themed($buttonText)} />
                  </Pressable>
                </GlassView>
              </View>
            </GlassView>
          </Animated.View>
        </Screen>
      </View>
    )
  }

  return (
    <View style={$staticContainer}>
      <StatusBar barStyle="light-content" />
      <View style={$staticBackgroundPattern}>
        <View style={$staticDecorativeCircle1} />
        <View style={$staticDecorativeCircle2} />
        <View style={$staticDecorativeCircle3} />
      </View>
      <Screen
        preset="fixed"
        contentContainerStyle={$staticScreenContainer}
        safeAreaEdges={["top", "bottom"]}
        backgroundColor="transparent"
      >
        <Animated.View
          entering={FadeIn.duration(600)}
          exiting={FadeOut}
          style={$staticCenteredContent}
        >
          <GlassView glassEffectStyle="clear" isInteractive={false} style={$staticCardGlass}>
            <View style={$staticCardContent}>
              <EmailInputForm
                email={email}
                onChangeText={handleEmailChange}
                onSubmit={handleEmailSubmit}
                isLoading={isLoading}
                isEmailValid={isEmailValid}
                error={error}
                inputRef={emailInputRef}
              />
            </View>
          </GlassView>
        </Animated.View>
      </Screen>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $backgroundPattern: ThemedStyle<ViewStyle> = ({ isDark }) => ({
  position: "absolute",
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  backgroundColor: isDark ? "#1a1a2e" : "#667eea",
})

const $decorativeCircle1: ThemedStyle<ViewStyle> = ({ isDark }) => ({
  position: "absolute",
  width: 400,
  height: 400,
  borderRadius: 200,
  backgroundColor: isDark ? "rgba(118, 75, 162, 0.3)" : "rgba(118, 75, 162, 0.6)",
  top: -150,
  right: -150,
})

const $decorativeCircle2: ThemedStyle<ViewStyle> = ({ isDark }) => ({
  position: "absolute",
  width: 350,
  height: 350,
  borderRadius: 175,
  backgroundColor: isDark ? "rgba(240, 147, 251, 0.25)" : "rgba(240, 147, 251, 0.5)",
  bottom: -120,
  left: -120,
})

const $decorativeCircle3: ThemedStyle<ViewStyle> = ({ isDark }) => ({
  position: "absolute",
  width: 200,
  height: 200,
  borderRadius: 100,
  backgroundColor: isDark ? "rgba(102, 126, 234, 0.4)" : "rgba(102, 200, 234, 0.7)",
  top: "50%",
  left: "50%",
  transform: [{ translateX: -100 }, { translateY: -100 }],
})

const $screenContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingVertical: 24,
})

const $centeredContent: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  paddingHorizontal: spacing.lg,
  width: "100%",
  maxWidth: 440,
})

const $cardGlass: ThemedStyle<ViewStyle> = () => ({
  width: "100%",
  height: 500,
  borderRadius: 25,
  backgroundColor: "rgba(255, 255, 255, 0.1)",
})

const $cardContent: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  padding: spacing.xl,
  paddingTop: spacing.xxl,
  paddingBottom: spacing.xl,
  gap: spacing.md,
})

const $title: ThemedStyle<TextStyle> = ({ typography, spacing }) => ({
  textAlign: "center",
  color: "white",
  fontFamily: typography.primary.semiBold,
  fontSize: 28,
  marginBottom: spacing.xs,
})

const $description: ThemedStyle<TextStyle> = ({ spacing, typography }) => ({
  textAlign: "center",
  color: "rgba(255, 255, 255, 0.9)",
  fontSize: 15,
  lineHeight: 22,
  marginBottom: spacing.md,
  fontFamily: typography.primary.normal,
})

const $emailDisplay: ThemedStyle<TextStyle> = ({ typography, spacing }) => ({
  textAlign: "center",
  color: "white",
  fontFamily: typography.primary.semiBold,
  fontSize: 16,
  marginBottom: spacing.sm,
})

const $staticContainer: ViewStyle = {
  flex: 1,
}

const $staticBackgroundPattern: ViewStyle = {
  position: "absolute",
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  backgroundColor: "#667eea",
}

const $staticDecorativeCircle1: ViewStyle = {
  position: "absolute",
  width: 400,
  height: 400,
  borderRadius: 200,
  backgroundColor: "rgba(118, 75, 162, 0.6)",
  top: -150,
  right: -150,
}

const $staticDecorativeCircle2: ViewStyle = {
  position: "absolute",
  width: 350,
  height: 350,
  borderRadius: 175,
  backgroundColor: "rgba(240, 147, 251, 0.5)",
  bottom: -120,
  left: -120,
}

const $staticDecorativeCircle3: ViewStyle = {
  position: "absolute",
  width: 200,
  height: 200,
  borderRadius: 100,
  backgroundColor: "rgba(102, 200, 234, 0.7)",
  top: "50%",
  left: "50%",
  transform: [{ translateX: -100 }, { translateY: -100 }],
}

const $staticScreenContainer: ViewStyle = {
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingVertical: 24,
}

const $staticCenteredContent: ViewStyle = {
  paddingHorizontal: 24,
  width: "100%",
  maxWidth: 440,
}

const $staticCardGlass: ViewStyle = {
  width: "100%",
  height: 500,
  borderRadius: 25,
  backgroundColor: "rgba(255, 255, 255, 0.1)",
}

const $staticCardContent: ViewStyle = {
  padding: 32,
  paddingTop: 40,
  paddingBottom: 32,
  gap: 16,
}

const $staticLogoContainer: ViewStyle = {
  alignItems: "center",
  marginBottom: 24,
}

const $staticTitle: TextStyle = {
  textAlign: "center",
  color: "white",
  fontFamily: "System",
  fontWeight: "600",
  fontSize: 28,
  marginBottom: 4,
}

const $staticDescription: TextStyle = {
  textAlign: "center",
  color: "rgba(255, 255, 255, 0.9)",
  fontSize: 15,
  lineHeight: 22,
  marginBottom: 16,
  fontFamily: "System",
}

const $staticInputLabel: TextStyle = {
  color: "white",
  fontSize: 14,
  fontFamily: "System",
  marginBottom: 8,
}

const $staticInputWrapper: ViewStyle = {
  width: "100%",
  height: 56,
  backgroundColor: "rgba(255, 255, 255, 0.2)",
  borderRadius: 12,
  borderWidth: 1,
  borderColor: "rgba(255, 255, 255, 0.3)",
  paddingHorizontal: 16,
  justifyContent: "center",
}

const $staticInput: TextStyle = {
  color: "white",
  fontSize: 16,
  fontFamily: "System",
  flex: 1,
}

const $staticErrorText: TextStyle = {
  color: "#ff6b6b",
  fontSize: 12,
  fontFamily: "System",
  marginTop: 8,
}

const $staticButtonWrapper: ViewStyle = {
  width: "100%",
  height: 56,
  borderRadius: 16,
  borderWidth: 1,
  borderColor: "rgba(255, 255, 255, 0.3)",
  overflow: "hidden",
}

const $staticButtonAnimatedWrapper: ViewStyle = {
  flex: 1,
  borderRadius: 16,
}

const $staticButtonPressable: ViewStyle = {
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingHorizontal: 16,
}

const $staticButtonText: TextStyle = {
  color: "white",
  fontSize: 16,
  fontFamily: "System",
  fontWeight: "500",
  textAlign: "center",
}

const $staticHelperText: TextStyle = {
  textAlign: "center",
  color: "rgba(255, 255, 255, 0.8)",
  fontSize: 14,
  lineHeight: 20,
  marginTop: 16,
  fontFamily: "System",
}

const $buttonGlass: ThemedStyle<ViewStyle> = () => ({
  width: "100%",
  height: 56,
  borderRadius: 16,
  backgroundColor: "rgba(255, 255, 255, 0.1)",
})

const $buttonPressable: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingHorizontal: spacing.md,
})

const $buttonText: ThemedStyle<TextStyle> = ({ typography }) => ({
  color: "white",
  fontSize: 16,
  fontFamily: typography.primary.medium,
  textAlign: "center",
})

export default LoginScreen

import type { FC } from "react"
import { useState, useCallback, useRef, memo, useEffect } from "react"
import { View, Alert, StatusBar, Pressable, TextInput as RNTextInput } from "react-native"
import type { ViewStyle, TextStyle } from "react-native"
import { Video, ResizeMode } from "expo-av"
import { GlassView } from "expo-glass-effect"
import { Loader2 } from "lucide-react-native"
import Animated, {
  FadeIn,
  FadeOut,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolateColor,
  withRepeat,
  Easing,
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
  inputRef: React.RefObject<RNTextInput | null>
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
        {/* <Text preset="heading" tx="auth:welcomeToScani" style={$staticTitle} /> */}

        <View>
          <Text tx="auth:emailLabel" style={$staticInputLabel} />
          <View style={$staticInputWrapper}>
            <RNTextInput
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

interface LoadingSpinnerProps {
  size?: number
  color?: string
}

const LoadingSpinner: FC<LoadingSpinnerProps> = memo(({ size = 48, color = "white" }) => {
  const rotation = useSharedValue(0)

  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, {
        duration: 1000,
        easing: Easing.linear,
      }),
      -1,
      false,
    )
  }, [rotation])

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }))

  return (
    <Animated.View style={animatedStyle}>
      <Loader2 size={size} color={color} strokeWidth={2} />
    </Animated.View>
  )
})
LoadingSpinner.displayName = "LoadingSpinner"

export const LoginScreen: FC = () => {
  const { themed } = useAppTheme()
  const { authenticate, verifyCode } = useAuth()
  const [email, setEmail] = useState("")
  const [isEmailValid, setIsEmailValid] = useState(false)
  const [isEmailSent, setIsEmailSent] = useState(false)
  const [isSendingCode, setIsSendingCode] = useState(false)
  const [isVerifyingCode, setIsVerifyingCode] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const emailInputRef = useRef<RNTextInput>(null)

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

    setError(null)
    setIsEmailSent(true)
    setIsSendingCode(true)

    logger.info("Submitting email for authentication", { email })

    const result = await authenticate(email)

    setIsSendingCode(false)

    if (result.error) {
      logger.error("Email authentication failed", undefined, { email, error: result.error })
      setError(result.error)
      setIsEmailSent(false)
    } else {
      logger.info("OTP sent successfully", { email })
    }
  }, [email, authenticate])

  const handleCodeSubmit = useCallback(
    async (code: string) => {
      setError(null)
      setIsVerifyingCode(true)
      logger.info("Submitting verification code", { email })

      const result = await verifyCode(email, code)

      setIsVerifyingCode(false)

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
    setIsSendingCode(false)
    setError(null)
    setEmail("")
    setIsEmailValid(false)
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
        <Video
          source={require("../../assets/video/login_bg.mp4")}
          style={$videoBackground}
          resizeMode={ResizeMode.COVER}
          shouldPlay
          isLooping
          isMuted
        />
        <View style={$videoOverlay} />
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
                {isSendingCode ? (
                  <>
                    <View style={$loadingContainer}>
                      <View style={$spinnerWrapper}>
                        <LoadingSpinner size={32} color="rgba(255, 255, 255, 0.2)" />
                      </View>
                      <Text tx="auth:sendingCode" style={themed($sendingText)} />
                    </View>
                  </>
                ) : (
                  <>
                    <Text preset="heading" tx="auth:checkYourEmail" style={themed($title)} />
                    <Text tx="auth:codeSent" txOptions={{ email }} style={themed($description)} />

                    <MagicCodeInput
                      onSubmit={handleCodeSubmit}
                      onResend={handleResendCode}
                      isLoading={isVerifyingCode}
                      error={error}
                      resendCooldown={30}
                      hideHelperText
                    />

                    <Pressable onPress={handleUseDifferentEmail} style={$linkContainer}>
                      <Text tx="auth:useDifferentEmail" style={$linkText} />
                    </Pressable>
                  </>
                )}
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
      <Video
        source={require("../../assets/video/login_bg.mp4")}
        style={$videoBackground}
        resizeMode={ResizeMode.COVER}
        shouldPlay
        isLooping
        isMuted
      />
      <View style={$videoOverlay} />
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
          <View style={$logoContainer}>
            <SvgIcon name="scani-logo" width={120} height={34} />
          </View>
          <GlassView glassEffectStyle="clear" isInteractive={false} style={$staticCardGlass}>
            <View style={$staticCardContent}>
              <EmailInputForm
                email={email}
                onChangeText={handleEmailChange}
                onSubmit={handleEmailSubmit}
                isLoading={false}
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
  borderRadius: 25,
  backgroundColor: "rgba(255, 255, 255, 0.1)",
})

const $cardContent: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  padding: spacing.sm,
  gap: spacing.sm,
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

const $staticContainer: ViewStyle = {
  flex: 1,
}

const $videoBackground: ViewStyle = {
  position: "absolute",
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
}

const $videoOverlay: ViewStyle = {
  position: "absolute",
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  backgroundColor: "rgba(0, 0, 0, 0.6)",
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
  borderRadius: 25,
  backgroundColor: "rgba(255, 255, 255, 0.1)",
}

const $staticCardContent: ViewStyle = {
  padding: 16,
  gap: 8,
}

const $logoContainer: ViewStyle = {
  alignItems: "center",
  justifyContent: "center",
  marginBottom: 24,
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
  marginBottom: 16,
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

const $linkContainer: ViewStyle = {
  alignItems: "center",
  paddingVertical: 12,
}

const $linkText: TextStyle = {
  color: "rgba(255, 255, 255, 0.9)",
  fontSize: 15,
  textAlign: "center",
}

const $loadingContainer: ViewStyle = {
  alignItems: "center",
  justifyContent: "center",
  paddingVertical: 40,
  gap: 24,
}

const $spinnerWrapper: ViewStyle = {
  marginBottom: 8,
}

const $sendingText: ThemedStyle<TextStyle> = ({ typography }) => ({
  textAlign: "center",
  color: "white",
  fontFamily: typography.primary.normal,
  fontSize: 18,
})

export default LoginScreen

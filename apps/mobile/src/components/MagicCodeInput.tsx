import { FC, useEffect, useRef, useState, memo } from "react"
import {
  View,
  // eslint-disable-next-line no-restricted-imports
  TextInput,
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
  ViewStyle,
  TextStyle,
} from "react-native"
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
} from "react-native-reanimated"
import { Loader2 } from "lucide-react-native"

import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

import { Button } from "./Button"
import { Text } from "./Text"

interface MagicCodeInputProps {
  onSubmit: (code: string) => Promise<void>
  onResend: () => Promise<void>
  isLoading?: boolean
  error?: string | null
  resendCooldown?: number
  hideHelperText?: boolean
}

interface LoadingSpinnerProps {
  size?: number
  color?: string
}

const LoadingSpinner: FC<LoadingSpinnerProps> = memo(({ size = 16, color = "white" }) => {
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

export const MagicCodeInput: FC<MagicCodeInputProps> = ({
  onSubmit,
  onResend,
  isLoading = false,
  error,
  resendCooldown = 30,
  hideHelperText = false,
}) => {
  const { themed, theme } = useAppTheme()
  const [code, setCode] = useState<string[]>(["", "", "", "", "", ""])
  const [isResending, setIsResending] = useState(false)
  const [resendCooldownRemaining, setResendCooldownRemaining] = useState(resendCooldown)
  const inputRefs = useRef<(TextInput | null)[]>([])

  useEffect(() => {
    inputRefs.current[0]?.focus()
  }, [])

  useEffect(() => {
    if (resendCooldownRemaining > 0) {
      const timer = setTimeout(() => {
        setResendCooldownRemaining((prev) => prev - 1)
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [resendCooldownRemaining])

  const handleChange = (index: number, value: string) => {
    if (value && !/^\d$/.test(value)) return

    const newCode = [...code]
    newCode[index] = value
    setCode(newCode)

    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus()
    }

    if (newCode.every((digit) => digit !== "") && !isLoading) {
      onSubmit(newCode.join(""))
    }
  }

  const handleKeyPress = (index: number, e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (e.nativeEvent.key === "Backspace") {
      if (!code[index] && index > 0) {
        inputRefs.current[index - 1]?.focus()
      } else {
        const newCode = [...code]
        newCode[index] = ""
        setCode(newCode)
      }
    }
  }

  const handleResend = async () => {
    setIsResending(true)
    setCode(["", "", "", "", "", ""])
    await onResend()
    setIsResending(false)
    setResendCooldownRemaining(resendCooldown)
    inputRefs.current[0]?.focus()
  }

  return (
    <View style={themed($container)}>
      <View style={themed($inputsWrapper)}>
        <Text preset="formLabel" tx="auth:enterCodeDescription" style={themed($label)} />
        <View style={themed($inputsRow)}>
          {code.map((digit, index) => (
            <TextInput
              key={`code-${index}`}
              ref={(el) => {
                inputRefs.current[index] = el
              }}
              style={themed([
                $input,
                error ? $inputError : null,
                (isLoading || isResending) && $inputDisabled,
              ])}
              value={digit}
              onChangeText={(value) => handleChange(index, value)}
              onKeyPress={(e) => handleKeyPress(index, e)}
              keyboardType="number-pad"
              maxLength={1}
              editable={!isLoading && !isResending}
              selectTextOnFocus
              autoFocus={index === 0}
              placeholderTextColor="rgba(255, 255, 255, 0.5)"
            />
          ))}
        </View>
        {error && <Text style={themed($errorText)}>{error}</Text>}
      </View>

      <Button
        preset="default"
        onPress={handleResend}
        disabled={isResending || isLoading || resendCooldownRemaining > 0}
        tx={resendCooldownRemaining > 0 ? "auth:resendCodeIn" : "auth:resendCode"}
        txOptions={
          resendCooldownRemaining > 0 ? { seconds: resendCooldownRemaining } : undefined
        }
        style={$secondaryButton}
        textStyle={$secondaryButtonText}
        disabledStyle={$disabledButton}
        RightAccessory={isResending ? () => <LoadingSpinner size={16} color="white" /> : undefined}
      />

      {!hideHelperText && (
        <Text preset="formHelper" tx="auth:codeExpires" style={themed($helperText)} />
      )}
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  gap: spacing.lg,
})

const $inputsWrapper: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  gap: spacing.sm,
})

const $label: ThemedStyle<TextStyle> = () => ({
  textAlign: "center",
  color: "rgba(255, 255, 255, 0.9)",
  fontSize: 15,
  lineHeight: 22,
})

const $inputsRow: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flexDirection: "row",
  justifyContent: "center",
  gap: spacing.xs,
})

const $input: ThemedStyle<TextStyle> = ({ typography }) => ({
  width: 48,
  height: 56,
  textAlign: "center",
  fontSize: 24,
  fontFamily: typography.primary.bold,
  borderWidth: 1,
  borderRadius: 12,
  borderColor: "rgba(255, 255, 255, 0.3)",
  backgroundColor: "rgba(255, 255, 255, 0.2)",
  color: "white",
})

const $inputError: ThemedStyle<TextStyle> = () => ({
  borderColor: "#ff6b6b",
})

const $inputDisabled: ThemedStyle<TextStyle> = () => ({
  opacity: 0.5,
})

const $errorText: ThemedStyle<TextStyle> = ({ spacing }) => ({
  color: "#ff6b6b",
  textAlign: "center",
  marginTop: spacing.xs,
  fontSize: 14,
})

const $secondaryButton: ViewStyle = {
  height: 56,
  borderRadius: 16,
  borderWidth: 1,
  borderColor: "rgba(255, 255, 255, 0.3)",
  backgroundColor: "rgba(255, 255, 255, 0.1)",
}

const $secondaryButtonText: TextStyle = {
  color: "white",
  fontSize: 16,
  fontWeight: "500",
}

const $disabledButton: ViewStyle = {
  opacity: 0.5,
}

const $helperText: ThemedStyle<TextStyle> = () => ({
  textAlign: "center",
  color: "rgba(255, 255, 255, 0.8)",
  fontSize: 14,
})

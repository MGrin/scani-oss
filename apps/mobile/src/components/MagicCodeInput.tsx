import { FC, useEffect, useRef, useState } from "react"
import {
  View,
  // eslint-disable-next-line no-restricted-imports
  TextInput,
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
  ViewStyle,
  TextStyle,
  ActivityIndicator,
} from "react-native"

import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

import { Button } from "./Button"
import { Text } from "./Text"

interface MagicCodeInputProps {
  onSubmit: (code: string) => Promise<void>
  onResend: () => Promise<void>
  isLoading?: boolean
  error?: string | null
}

export const MagicCodeInput: FC<MagicCodeInputProps> = ({
  onSubmit,
  onResend,
  isLoading = false,
  error,
}) => {
  const { themed, theme } = useAppTheme()
  const [code, setCode] = useState<string[]>(["", "", "", "", "", ""])
  const [isResending, setIsResending] = useState(false)
  const inputRefs = useRef<(TextInput | null)[]>([])

  useEffect(() => {
    inputRefs.current[0]?.focus()
  }, [])

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
    inputRefs.current[0]?.focus()
  }

  const handleManualSubmit = () => {
    const codeString = code.join("")
    if (codeString.length === 6) {
      onSubmit(codeString)
    }
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
              placeholderTextColor={theme.colors.textDim}
            />
          ))}
        </View>
        {error && <Text style={themed($errorText)}>{error}</Text>}
      </View>

      <View style={themed($buttonsWrapper)}>
        <Button
          preset="filled"
          onPress={handleManualSubmit}
          disabled={code.join("").length !== 6 || isLoading}
          tx="auth:verifyCode"
          RightAccessory={
            isLoading
              ? () => <ActivityIndicator size="small" color={theme.colors.palette.neutral100} />
              : undefined
          }
        />

        <Button
          preset="default"
          onPress={handleResend}
          disabled={isResending || isLoading}
          tx="auth:resendCode"
          RightAccessory={
            isResending
              ? () => <ActivityIndicator size="small" color={theme.colors.text} />
              : undefined
          }
        />
      </View>

      <Text preset="formHelper" tx="auth:codeExpires" style={themed($helperText)} />
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  gap: spacing.lg,
})

const $inputsWrapper: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  gap: spacing.sm,
})

const $label: ThemedStyle<TextStyle> = ({ colors }) => ({
  textAlign: "center",
  color: colors.textDim,
})

const $inputsRow: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flexDirection: "row",
  justifyContent: "center",
  gap: spacing.xs,
})

const $input: ThemedStyle<TextStyle> = ({ colors, typography }) => ({
  width: 48,
  height: 56,
  textAlign: "center",
  fontSize: 24,
  fontFamily: typography.primary.bold,
  borderWidth: 2,
  borderRadius: 8,
  borderColor: colors.palette.neutral400,
  backgroundColor: colors.palette.neutral200,
  color: colors.text,
})

const $inputError: ThemedStyle<TextStyle> = ({ colors }) => ({
  borderColor: colors.error,
})

const $inputDisabled: ThemedStyle<TextStyle> = () => ({
  opacity: 0.5,
})

const $errorText: ThemedStyle<TextStyle> = ({ colors, spacing }) => ({
  color: colors.error,
  textAlign: "center",
  marginTop: spacing.xs,
  fontSize: 14,
})

const $buttonsWrapper: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  gap: spacing.sm,
})

const $helperText: ThemedStyle<TextStyle> = ({ colors }) => ({
  textAlign: "center",
  color: colors.textDim,
})

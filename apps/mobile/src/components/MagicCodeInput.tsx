import { Loader2 } from "lucide-react-native";
import { type FC, forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from "react";
import { type TextStyle, View, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { OtpInput, type OtpInputRef } from "react-native-otp-entry";

import { useAppTheme } from "@/theme/context";
import type { ThemedStyle } from "@/theme/types";

import { Button } from "./Button";
import { Text } from "./Text";

export interface MagicCodeInputRef {
  focus: () => void;
  clear: () => void;
}

interface MagicCodeInputProps {
  onSubmit: (code: string) => Promise<void>;
  onResend: () => Promise<void>;
  isLoading?: boolean;
  error?: string | null;
  resendCooldown?: number;
  hideHelperText?: boolean;
}

interface LoadingSpinnerProps {
  size?: number;
  color?: string;
}

const LoadingSpinner: FC<LoadingSpinnerProps> = memo(
  ({ size = 16, color = "white" }) => {
    const rotation = useSharedValue(0);

    useEffect(() => {
      rotation.value = withRepeat(
        withTiming(360, {
          duration: 1000,
          easing: Easing.linear,
        }),
        -1,
        false
      );
    }, [rotation]);

    const animatedStyle = useAnimatedStyle(() => ({
      transform: [{ rotate: `${rotation.value}deg` }],
    }));

    return (
      <Animated.View style={animatedStyle}>
        <Loader2 size={size} color={color} strokeWidth={2} />
      </Animated.View>
    );
  }
);
LoadingSpinner.displayName = "LoadingSpinner";

export const MagicCodeInput = forwardRef<MagicCodeInputRef, MagicCodeInputProps>(({
  onSubmit,
  onResend,
  isLoading = false,
  error,
  resendCooldown = 30,
  hideHelperText = false,
}, ref) => {
  const { themed } = useAppTheme();
  const otpRef = useRef<OtpInputRef>(null);
  const [code, setCode] = useState("");
  const [isResending, setIsResending] = useState(false);
  const [resendCooldownRemaining, setResendCooldownRemaining] =
    useState(resendCooldown);

  useImperativeHandle(ref, () => ({
    focus: () => {
      otpRef.current?.focus();
    },
    clear: () => {
      otpRef.current?.clear();
      setCode("");
    },
  }));

  useEffect(() => {
    if (resendCooldownRemaining > 0) {
      const timer = setTimeout(() => {
        setResendCooldownRemaining((prev) => prev - 1);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [resendCooldownRemaining]);

  const handleFilled = async (text: string) => {
    if (!isLoading && !isResending) {
      await onSubmit(text);
    }
  };

  const handleResend = async () => {
    setIsResending(true);
    setCode("");
    await onResend();
    setIsResending(false);
    setResendCooldownRemaining(resendCooldown);
  };

  return (
    <View style={themed($container)}>
      <View style={themed($inputsWrapper)}>
        <Text
          preset="formLabel"
          tx="auth:enterCodeDescription"
          style={themed($label)}
        />
        <OtpInput
          ref={otpRef}
          numberOfDigits={6}
          onTextChange={setCode}
          onFilled={handleFilled}
          autoFocus={false}
          disabled={isLoading || isResending}
          type="numeric"
          focusColor="rgba(255, 255, 255, 0.9)"
          theme={{
            containerStyle: themed($otpContainer),
            pinCodeContainerStyle: themed($input),
            pinCodeTextStyle: themed($inputText),
            focusedPinCodeContainerStyle: themed($inputFocused),
            filledPinCodeContainerStyle: themed($inputFilled),
            disabledPinCodeContainerStyle: themed($inputDisabled),
            focusStickStyle: themed($focusStick),
          }}
        />
        {error && <Text style={themed($errorText)}>{error}</Text>}
      </View>

      <Button
        preset="default"
        onPress={handleResend}
        disabled={isResending || isLoading || resendCooldownRemaining > 0}
        tx={
          resendCooldownRemaining > 0 ? "auth:resendCodeIn" : "auth:resendCode"
        }
        txOptions={
          resendCooldownRemaining > 0
            ? { seconds: resendCooldownRemaining }
            : undefined
        }
        style={$secondaryButton}
        textStyle={$secondaryButtonText}
        disabledStyle={$disabledButton}
        RightAccessory={
          isResending
            ? () => <LoadingSpinner size={16} color="white" />
            : undefined
        }
      />

      {!hideHelperText && (
        <Text
          preset="formHelper"
          tx="auth:codeExpires"
          style={themed($helperText)}
        />
      )}
    </View>
  );
});

MagicCodeInput.displayName = "MagicCodeInput";

const $container: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  gap: spacing.lg,
});

const $inputsWrapper: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  gap: spacing.sm,
});

const $label: ThemedStyle<TextStyle> = () => ({
  textAlign: "center",
  color: "rgba(255, 255, 255, 0.9)",
  fontSize: 15,
  lineHeight: 22,
});

const $otpContainer: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flexDirection: "row",
  justifyContent: "center",
  gap: spacing.xs,
});

const $input: ThemedStyle<ViewStyle> = () => ({
  width: 48,
  height: 56,
  borderWidth: 1,
  borderRadius: 12,
  borderColor: "rgba(255, 255, 255, 0.3)",
  backgroundColor: "rgba(255, 255, 255, 0.2)",
});

const $inputText: ThemedStyle<TextStyle> = ({ typography }) => ({
  fontSize: 24,
  fontFamily: typography.primary.bold,
  color: "white",
});

const $inputFocused: ThemedStyle<ViewStyle> = () => ({
  borderColor: "rgba(255, 255, 255, 0.6)",
  backgroundColor: "rgba(255, 255, 255, 0.25)",
});

const $inputFilled: ThemedStyle<ViewStyle> = () => ({
  borderColor: "rgba(255, 255, 255, 0.5)",
});

const $inputDisabled: ThemedStyle<ViewStyle> = () => ({
  opacity: 0.5,
});

const $focusStick: ThemedStyle<ViewStyle> = () => ({
  backgroundColor: "rgba(255, 255, 255, 0.9)",
});

const $errorText: ThemedStyle<TextStyle> = ({ spacing }) => ({
  color: "#ff6b6b",
  textAlign: "center",
  marginTop: spacing.xs,
  fontSize: 14,
});

const $secondaryButton: ViewStyle = {
  height: 56,
  borderRadius: 16,
  borderWidth: 1,
  borderColor: "rgba(255, 255, 255, 0.3)",
  backgroundColor: "rgba(255, 255, 255, 0.1)",
};

const $secondaryButtonText: TextStyle = {
  color: "white",
  fontSize: 16,
  fontWeight: "500",
};

const $disabledButton: ViewStyle = {
  opacity: 0.5,
};

const $helperText: ThemedStyle<TextStyle> = () => ({
  textAlign: "center",
  color: "rgba(255, 255, 255, 0.8)",
  fontSize: 14,
});

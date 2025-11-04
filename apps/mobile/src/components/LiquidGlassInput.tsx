import { GlassView } from 'expo-glass-effect';
import { forwardRef, type Ref } from 'react';
import { Platform, type TextInput, type TextStyle, View, type ViewStyle } from 'react-native';

import { useAppTheme } from '@/theme/context';
import type { ThemedStyle } from '@/theme/types';

import { TextField, type TextFieldProps } from './TextField';

export interface LiquidGlassInputProps extends TextFieldProps {
  glassStyle?: ViewStyle;
}

export const LiquidGlassInput = forwardRef(function LiquidGlassInput(
  props: LiquidGlassInputProps,
  ref: Ref<TextInput>
) {
  const {
    glassStyle,
    inputWrapperStyle,
    style,
    LabelTextProps,
    HelperTextProps,
    label,
    labelTx,
    labelTxOptions,
    ...textFieldProps
  } = props;
  const { themed } = useAppTheme();

  if (Platform.OS !== 'ios') {
    return (
      <TextField
        {...textFieldProps}
        label={label}
        labelTx={labelTx}
        labelTxOptions={labelTxOptions}
        ref={ref}
        inputWrapperStyle={[themed($androidInputWrapper), inputWrapperStyle]}
        style={[themed($whiteText), style]}
        LabelTextProps={{ ...LabelTextProps, style: [themed($whiteText), LabelTextProps?.style] }}
        HelperTextProps={{
          ...HelperTextProps,
          style: [themed($whiteText), HelperTextProps?.style],
        }}
      />
    );
  }

  return (
    <View style={themed($wrapper)}>
      <TextField
        label={label}
        labelTx={labelTx}
        labelTxOptions={labelTxOptions}
        containerStyle={themed($labelContainer)}
        inputWrapperStyle={themed($hidden)}
        LabelTextProps={{
          ...LabelTextProps,
          style: [themed($whiteText), themed($labelStyle), LabelTextProps?.style],
        }}
      />
      <GlassView
        glassEffectStyle="clear"
        isInteractive={false}
        style={[themed($glassContainer), glassStyle]}
      >
        <View style={themed($innerContent)}>
          <TextField
            {...textFieldProps}
            ref={ref}
            inputWrapperStyle={[themed($transparentWrapper), inputWrapperStyle]}
            style={[themed($whiteText), style]}
            placeholderTextColor="rgba(255, 255, 255, 0.5)"
            HelperTextProps={{
              ...HelperTextProps,
              style: [themed($whiteText), HelperTextProps?.style],
            }}
          />
        </View>
      </GlassView>
    </View>
  );
});

const $wrapper: ThemedStyle<ViewStyle> = () => ({
  width: '100%',
});

const $labelContainer: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  marginBottom: spacing.xs,
});

const $labelStyle: ThemedStyle<TextStyle> = ({ spacing }) => ({
  marginBottom: spacing.xxs,
});

const $hidden: ThemedStyle<ViewStyle> = () => ({
  display: 'none',
});

const $glassContainer: ThemedStyle<ViewStyle> = () => ({
  width: '100%',
  height: 56,
  borderRadius: 12,
  backgroundColor: 'rgba(255, 255, 255, 0.1)',
});

const $innerContent: ThemedStyle<ViewStyle> = ({ spacing }) => ({
  flex: 1,
  justifyContent: 'center',
  alignItems: 'stretch',
  paddingHorizontal: spacing.md,
  width: '100%',
});

const $transparentWrapper: ThemedStyle<ViewStyle> = () => ({
  backgroundColor: 'transparent',
  borderWidth: 0,
  minHeight: 0,
  paddingVertical: 0,
  paddingHorizontal: 0,
});

const $whiteText: ThemedStyle<TextStyle> = ({ typography }) => ({
  color: 'white',
  fontSize: 16,
  fontFamily: typography.primary.normal,
});

const $androidInputWrapper: ThemedStyle<ViewStyle> = ({ isDark }) => ({
  backgroundColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.3)',
  borderColor: isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.15)',
});

import type { FC } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { View } from 'react-native';

import { useAppTheme } from '@/theme/context';

import { type SvgIconTypes, svgIconRegistry } from './registry';

export interface SvgIconProps {
  name: SvgIconTypes;
  size?: number;
  width?: number;
  height?: number;
  color?: string;
  gradientColors?: string[];
  gradientStart?: { x: number; y: number };
  gradientEnd?: { x: number; y: number };
  style?: StyleProp<ViewStyle>;
  containerStyle?: StyleProp<ViewStyle>;
}

export const SvgIcon: FC<SvgIconProps> = ({
  name,
  size = 24,
  width,
  height,
  color,
  gradientColors,
  gradientStart = { x: 0, y: 0 },
  gradientEnd = { x: 1, y: 1 },
  style,
  containerStyle,
}) => {
  const { theme } = useAppTheme();
  const IconComponent = svgIconRegistry[name];

  if (!IconComponent) {
    return null;
  }

  const iconColor = color ?? theme.colors.text;

  const svgProps: { width?: number; height?: number } = {};
  if (width !== undefined) {
    svgProps.width = width;
    if (height !== undefined) {
      svgProps.height = height;
    }
  } else if (height !== undefined) {
    svgProps.height = height;
  } else {
    svgProps.width = size;
    svgProps.height = size;
  }

  return (
    <View style={containerStyle}>
      <IconComponent {...svgProps} color={iconColor} style={style} />
    </View>
  );
};

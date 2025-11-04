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
  style?: StyleProp<ViewStyle>;
  containerStyle?: StyleProp<ViewStyle>;
}

export const SvgIcon: FC<SvgIconProps> = ({
  name,
  size = 24,
  width,
  height,
  color,
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

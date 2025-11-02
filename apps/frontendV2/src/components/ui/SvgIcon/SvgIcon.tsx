import type { CSSProperties, FC } from 'react';
import { svgIconRegistry, type SvgIconTypes } from './registry';

export interface SvgIconProps {
  name: SvgIconTypes;
  size?: number;
  color?: string;
  className?: string;
  style?: CSSProperties;
}

export const SvgIcon: FC<SvgIconProps> = ({
  name,
  size = 24,
  color,
  className = '',
  style,
}) => {
  const IconComponent = svgIconRegistry[name];

  if (!IconComponent) {
    console.warn(`Icon "${name}" not found in registry`);
    return null;
  }

  const iconColor = color || 'currentColor';

  return (
    <IconComponent
      width={size}
      height={size}
      color={iconColor}
      className={className}
      style={{
        flexShrink: 0,
        ...style,
      }}
    />
  );
};


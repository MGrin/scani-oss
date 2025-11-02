import type { FC } from "react"
import { View } from "react-native"
import type { StyleProp, ViewStyle } from "react-native"
import { useAppTheme } from "@/theme/context"
import { svgIconRegistry, type SvgIconTypes } from "./registry"

export interface SvgIconProps {
  name: SvgIconTypes
  size?: number
  color?: string
  gradientColors?: string[]
  gradientStart?: { x: number; y: number }
  gradientEnd?: { x: number; y: number }
  style?: StyleProp<ViewStyle>
  containerStyle?: StyleProp<ViewStyle>
}

export const SvgIcon: FC<SvgIconProps> = ({
  name,
  size = 24,
  color,
  gradientColors,
  gradientStart = { x: 0, y: 0 },
  gradientEnd = { x: 1, y: 1 },
  style,
  containerStyle,
}) => {
  const { theme } = useAppTheme()
  const IconComponent = svgIconRegistry[name]
  
  if (!IconComponent) {
    return null
  }
  
  const iconColor = color ?? theme.colors.text
  
  return (
    <View style={containerStyle}>
      <IconComponent width={size} height={size} color={iconColor} style={style} />
    </View>
  )
}

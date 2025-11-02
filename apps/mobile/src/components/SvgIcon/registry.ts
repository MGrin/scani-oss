import ScaniLogo from "@assets/images/scani-logo.svg"

export const svgIconRegistry = {
  "scani-logo": ScaniLogo,
} as const

export type SvgIconTypes = keyof typeof svgIconRegistry

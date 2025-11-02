import ScaniIcon from '@assets/icons/scani-icon.svg';
import ScaniLogo from '@assets/images/scani-logo.svg';

export const svgIconRegistry = {
  'scani-icon': ScaniIcon,
  'scani-logo': ScaniLogo,
} as const;

export type SvgIconTypes = keyof typeof svgIconRegistry;

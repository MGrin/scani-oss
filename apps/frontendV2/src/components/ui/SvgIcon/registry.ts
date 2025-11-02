import type { FC, SVGProps } from 'react';

const svgModules = import.meta.glob<{ default: FC<SVGProps<SVGSVGElement>> }>(
  '@/assets/icons/svg/*.svg',
  { eager: true, query: '?react' },
);

export const svgIconRegistry = Object.entries(svgModules).reduce(
  (acc, [path, module]) => {
    const filename = path.split('/').pop()?.replace('.svg', '') || '';
    acc[filename] = module.default;
    return acc;
  },
  {} as Record<string, FC<SVGProps<SVGSVGElement>>>,
);

export type SvgIconTypes = keyof typeof svgIconRegistry;


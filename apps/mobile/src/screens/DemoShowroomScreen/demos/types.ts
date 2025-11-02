import type { ReactElement } from 'react';
import type { TxKeyPath } from '@/i18n';
import type { Theme } from '@/theme/types';

export interface Demo {
  name: string;
  description: TxKeyPath;
  data: ({ themed, theme }: { themed: any; theme: Theme }) => ReactElement[];
}

import type { ReactElement } from 'react';
import type { TxKeyPath } from '@/i18n';
import type { Theme, ThemedFnT } from '@/theme/types';

export interface Demo {
  name: string;
  description: TxKeyPath;
  data: ({ themed, theme }: { themed: ThemedFnT; theme: Theme }) => ReactElement[];
}

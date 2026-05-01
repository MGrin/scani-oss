import type { AppRouter } from '@scani/data-provider/types';
import { createTRPCReact } from '@trpc/react-query';

export const trpc = createTRPCReact<AppRouter>();

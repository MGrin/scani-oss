/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLOUD_URL?: string;
  readonly VITE_ADMIN_URL?: string;
}

declare module '*.svg?react' {
  import type { FC, SVGProps } from 'react';

  const content: FC<SVGProps<SVGSVGElement>>;
  export default content;
}

declare module '*.svg' {
  const content: string;
  export default content;
}

declare const __SCANI_CORE_BUILD__: {
  productVersion: string;
  releaseCommit: string;
  coreFingerprint: string;
  pendingChangeCount: number;
} | null;
declare const __SCANI_BUILD_COMMIT__: string | null;

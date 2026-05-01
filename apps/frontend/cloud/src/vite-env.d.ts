/// <reference types="vite/client" />

declare module '*.css';

interface ImportMetaEnv {
  readonly VITE_DATA_PROVIDER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

import { generateOpenAPIDocumentFromTRPCRouter } from 'openapi-trpc';
import type { MobileContractRouter } from './mobile-contract-router';

export function buildOpenApiDoc(router: MobileContractRouter) {
  const doc = generateOpenAPIDocumentFromTRPCRouter(router, {
    pathPrefix: '/trpc',
  });

  // Pin info for a deterministic, reviewable artifact (don't depend on the
  // library's defaults, which could change between versions).
  return { ...doc, info: { title: 'Scani API', version: '0.1.0' } };
}

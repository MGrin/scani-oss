import { BoundedFetchError, fetchHtmlBounded } from '@scani/http-fetch';
import { createComponentLogger } from '@scani/logging';
import { TRPCError } from '@trpc/server';
import ogs from 'open-graph-scraper';
import { z } from 'zod';
import { bearerProcedure, router } from '../trpc';

/**
 * OG metadata fetch. Backend calls this for the institution-autofill
 * feature ("user pastes revolut.com, we autofill name + icon"). The
 * SSRF-hardened `fetchHtmlBounded` helper + `open-graph-scraper` live
 * here, behind the bearer gate, because the data-provider is the only
 * service we want making arbitrary outbound HTTP on behalf of the user.
 *
 * Per-user rate gating still happens on the backend side — that keeper
 * needs the authenticated userId which the data-provider doesn't have.
 */

const log = createComponentLogger('data-provider:og');

export interface OGMetadata {
  title: string;
  description: string;
  siteName: string;
  image: string;
  type: string;
  finalUrl: string;
  truncated: boolean;
}

const EMPTY: OGMetadata = {
  title: '',
  description: '',
  siteName: '',
  image: '',
  type: '',
  finalUrl: '',
  truncated: false,
};

export const ogRouter = router({
  fetchMetadata: bearerProcedure
    .meta({
      openapi: {
        method: 'GET',
        path: '/trpc/og.fetchMetadata',
        tags: ['og'],
        summary: 'Fetch Open Graph metadata for a URL (SSRF-hardened)',
        protect: true,
      },
    })
    .input(z.object({ url: z.string().url() }))
    .output(z.unknown())
    .query(async ({ input }): Promise<OGMetadata> => {
      try {
        const { html, truncated, finalUrl } = await fetchHtmlBounded(input.url);
        if (!html) return { ...EMPTY, finalUrl };
        const { result } = await ogs({ html });
        return {
          title: result.ogTitle || result.twitterTitle || result.dcTitle || '',
          description:
            result.ogDescription || result.twitterDescription || result.dcDescription || '',
          siteName: result.ogSiteName || '',
          image: result.ogImage?.[0]?.url || result.twitterImage?.[0]?.url || '',
          type: result.ogType || '',
          finalUrl,
          truncated,
        };
      } catch (err) {
        if (err instanceof BoundedFetchError) {
          // The backend treats any throw as "no OG available", so mapping
          // every refusal reason to an empty result keeps the contract
          // simple. The reason is logged here for server-side debugging.
          log.debug(
            { url: input.url, reason: err.reason, message: err.message },
            'OG fetch refused'
          );
          return EMPTY;
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
});

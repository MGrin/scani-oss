/**
 * Extract a small, display-friendly summary from a user-initiated job
 * payload for the `user_jobs.payload_summary` column.
 *
 * Contract: **allowlist specific fields per job name**, never spread the raw
 * payload. Credentials are already encrypted upstream (see
 * packages/core/src/security/credentials.ts) so they aren't in these
 * payloads, but treat this as defense in depth — future payloads could add
 * a field we don't want surfaced in the `/jobs` list UI.
 *
 * The shape returned here is consumed by the frontend's `<JobSummary>`
 * component; keep it stable or change the frontend together with it.
 */

import { JOB_NAMES } from './queue-names';
import type {
  ExchangeImportJob,
  FileImportJob,
  HoldingPriceUpdateJob,
  ScreenshotParseJob,
  UserDataDeleteJob,
  WalletImportJob,
} from './types';

type UserJobName =
  | typeof JOB_NAMES.screenshotParse
  | typeof JOB_NAMES.exchangeImport
  | typeof JOB_NAMES.walletImport
  | typeof JOB_NAMES.fileImport
  | typeof JOB_NAMES.holdingPriceUpdate
  | typeof JOB_NAMES.userDataDelete;

type UserJobDataMap = {
  [JOB_NAMES.screenshotParse]: ScreenshotParseJob;
  [JOB_NAMES.exchangeImport]: ExchangeImportJob;
  [JOB_NAMES.walletImport]: WalletImportJob;
  [JOB_NAMES.fileImport]: FileImportJob;
  [JOB_NAMES.holdingPriceUpdate]: HoldingPriceUpdateJob;
  [JOB_NAMES.userDataDelete]: UserDataDeleteJob;
};

/** Mask the middle of a blockchain address for UI display. */
function redactAddress(addr: string): string {
  if (typeof addr !== 'string' || addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function summarizePayload<Name extends UserJobName>(
  name: Name,
  data: UserJobDataMap[Name]
): Record<string, unknown> {
  switch (name) {
    case JOB_NAMES.walletImport: {
      const d = data as WalletImportJob;
      return { chain: d.chain, address: redactAddress(d.address), label: d.label };
    }
    case JOB_NAMES.screenshotParse: {
      const d = data as ScreenshotParseJob;
      return {
        fileCount: d.r2Keys.length,
        provider: d.provider,
        accountType: d.accountType,
        expectedCurrency: d.expectedCurrency,
        accountId: d.accountId,
      };
    }
    case JOB_NAMES.exchangeImport: {
      const d = data as ExchangeImportJob;
      return { institutionId: d.institutionId, provider: d.provider };
    }
    case JOB_NAMES.fileImport: {
      const d = data as FileImportJob;
      return { fileType: d.fileType, accountId: d.accountId, enrich: d.enrich ?? false };
    }
    case JOB_NAMES.holdingPriceUpdate: {
      const d = data as HoldingPriceUpdateJob;
      return { holdingId: d.holdingId };
    }
    case JOB_NAMES.userDataDelete: {
      return {};
    }
    default: {
      const _exhaustive: never = name;
      throw new Error(`No payload summarizer for job '${_exhaustive}'`);
    }
  }
}

// `sanitizeResult` lives next door in `./sanitize-result.ts` so the worker
// side can also use it without pulling in the whole summarize allowlist.

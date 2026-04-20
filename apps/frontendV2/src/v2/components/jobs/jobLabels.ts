/**
 * Human labels + icons for each user-initiated job name. Shared by the
 * /jobs list row, the /jobs/:jobId header, and the top-nav badge tooltip.
 * Keep in sync with `JOB_NAMES` in packages/core/src/queues/queue-names.ts.
 */

import type { LucideIcon } from 'lucide-react';
import {
  Coins,
  DollarSign,
  FileSpreadsheet,
  Image as ImageIcon,
  Link2,
  Trash2,
} from 'lucide-react';

export interface JobLabel {
  label: string;
  icon: LucideIcon;
}

const FALLBACK: JobLabel = { label: 'Background task', icon: Coins };

const BY_NAME: Record<string, JobLabel> = {
  'wallet-import': { label: 'Wallet import', icon: Coins },
  'exchange-import': { label: 'Exchange import', icon: Link2 },
  // Covers both images and PDFs — the label in the result body
  // differentiates further based on the file extension.
  'screenshot-parse': { label: 'Document parse', icon: ImageIcon },
  'file-import': { label: 'File import', icon: FileSpreadsheet },
  'holding-price-update': { label: 'Price refresh', icon: DollarSign },
  'user-data-delete': { label: 'Account deletion', icon: Trash2 },
};

export function jobLabelFor(jobName: string): JobLabel {
  return BY_NAME[jobName] ?? { ...FALLBACK, label: jobName };
}

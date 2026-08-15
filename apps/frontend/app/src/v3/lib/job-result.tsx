import {
  type ReviewRenderer,
  resolveReviewRenderer as resolveV2ReviewRenderer,
} from '@/v2/lib/review-registry';
import { DocumentParseResult } from '../components/jobs/DocumentParseResult';

/**
 * Which component renders a job's result in v3, for the job kinds where v2's
 * answer is wrong here.
 *
 * v3's `JobDetailPage` renders v2's registry unchanged, and that is the right
 * default: a review renderer is the *result* contract with the worker, not
 * presentation v3 gets to restyle unilaterally, and forking seven components to
 * change their padding would be the worst kind of duplication.
 *
 * `document-parse` is the exception, and not for styling. v2's renderer ends at
 * a link to `/documents/<id>`, because in v2 the decision lives on that page.
 * In v3 the invoice upload lands *here* — `InvoiceUploadPage` navigates to the
 * job — and the next action a person needs is the payment form, not a second
 * navigation to a screen v3 has not built. So v3 overrides this one entry and
 * delegates everything else, which keeps the fork to the single job kind whose
 * onward path genuinely differs between the two generations.
 */
const V3_RENDERERS: Record<string, ReviewRenderer> = {
  'document-parse': {
    kind: 'document-parse',
    render: ({ result }) => <DocumentParseResult result={result} />,
  },
};

export function resolveV3ReviewRenderer(kind: string): ReviewRenderer {
  return V3_RENDERERS[kind] ?? resolveV2ReviewRenderer(kind);
}

import { TooltipProvider } from '@scani/ui/ui/tooltip';
import { Navigate, Route, Routes } from 'react-router-dom';
import { lazyRoute } from '@/lib/lazy-route';
import { V3ErrorBoundary } from './components/V3ErrorBoundary';
// Registers v3's own half of every locale into the app's i18next instance.
// Side-effect import, and it belongs here rather than deeper: this is the
// module every v3 route is reached through (SC-169).
import './i18n';
import { useViewTransitionLocation } from './hooks/useViewTransitionLocation';
import { V3Shell } from './layouts/V3Shell';
import { useInstallPdfExport } from './lib/pdf-export';
import {
  BALANCE_GAP_REVIEW_PATH,
  TRANSFER_ANSWERED_PATH,
  TRANSFER_REVIEW_PATH,
  TRANSFER_RULES_PATH,
  V3_CAPTURE_ROUTES,
  V3_ROUTES,
} from './lib/routes';
import { V3_BASE } from './lib/ui-version';
import { AccountsPage } from './pages/AccountsPage';
import { AnsweredTransfersPage } from './pages/AnsweredTransfersPage';
import { BalanceGapsReviewPage } from './pages/BalanceGapsReviewPage';
import { DocumentDetailPage } from './pages/DocumentDetailPage';
import { EntitiesPage } from './pages/EntitiesPage';
import { FileImportPage } from './pages/FileImportPage';
import { FilesPage } from './pages/FilesPage';
import { GroupDetailPage } from './pages/GroupDetailPage';
import { GroupsPage } from './pages/GroupsPage';
import { HoldingsPage } from './pages/HoldingsPage';
import { HomePage } from './pages/HomePage';
import { InstitutionsPage } from './pages/InstitutionsPage';
import { IntegrationConnectPage } from './pages/IntegrationConnectPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { InvoiceUploadPage } from './pages/InvoiceUploadPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { JobsPage } from './pages/JobsPage';
import { ManualEntryPage } from './pages/ManualEntryPage';
import { MoneyPage } from './pages/MoneyPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PaymentFormPage } from './pages/PaymentFormPage';
import { RecordMovementPage } from './pages/RecordMovementPage';
import { ReviewPage } from './pages/ReviewPage';
import { SettingsPage } from './pages/SettingsPage';
import { TokensPage } from './pages/TokensPage';
import { TransferRulesPage } from './pages/TransferRulesPage';
import { TransfersReviewPage } from './pages/TransfersReviewPage';
import { VaultDetailPage } from './pages/VaultDetailPage';
import { VaultsPage } from './pages/VaultsPage';
import { WalletImportPage } from './pages/WalletImportPage';

/** `/payments` → `payments`. Routes inside `V3Shell` are relative to it. */
function relative(path: string): string {
  return path.slice(V3_BASE.length);
}

/**
 * The primitive gallery, fetched only if someone opens it (SC-132 #6).
 *
 * 20.1 KB of the production bundle for a screen that is unlinked — no nav
 * entry, no `V3_ROUTE_PATTERNS` entry, reachable only by typing the URL. It is
 * the clearest case in the app of a payload every reader carries and almost
 * none reaches.
 */
const KitchenSinkPage = lazyRoute('component gallery', () =>
  import('./pages/KitchenSinkPage').then((m) => m.KitchenSinkPage)
);

export function V3App() {
  // Teaches the shared export path how to make a PDF (SC-94). Registered here
  // rather than in `@scani/ui` because rendering one is a server call, and the
  // design system does not get a network client.
  useInstallPdfExport();

  // The location the tree renders, which lags the router by one commit while a
  // route change is being cross-faded (V3-16). Bails out to the router's own
  // location wherever the View Transitions API is missing or the user has
  // asked for reduced motion, so this is the identity function on every path
  // that is not being animated.
  const location = useViewTransitionLocation();

  return (
    <V3ErrorBoundary>
      <TooltipProvider delayDuration={0}>
        <Routes location={location}>
          <Route element={<V3Shell />}>
            <Route index element={<HomePage />} />
            {/* The primitive gallery (V3-06). Unlinked and deletable — this
                line plus KitchenSinkPage.tsx are its whole footprint, and since
                SC-132 it is not in the bundle either (see `KitchenSinkPage`
                above).

                The optional `:peekId` is the peek sheet's URL (V3-11). It has
                to be *one* route rather than an index route plus a child, or
                opening a record moves the page to a different position in the
                tree, React remounts it, and the list resets its scroll and its
                state the moment you tap a row. Every surface that declares a
                `peek` registers its path the same way. */}
            <Route path="kitchen-sink/:peekId?" element={<KitchenSinkPage />} />

            {/* Holdings (V3-12). Same optional `:peekId` as above, and for the
                same reason — a record has to open without moving the list to a
                different position in the route tree. */}
            <Route path={`${relative(V3_ROUTES.holdings)}/:peekId?`} element={<HoldingsPage />} />

            {/* Money (V3-13) — one surface, three views, four routes.

                The form's two paths are registered before the peek so React
                Router's static-over-dynamic ranking cannot be the only thing
                keeping `/payments/recurring/new` out of the peek's id space.
                The peeks themselves are `:peekId?` on the view's own route for
                the reason in the kitchen-sink note above: an index route plus a
                child would remount the list every time a row is tapped. */}
            <Route path={`${relative(V3_ROUTES.recurring)}/new`} element={<PaymentFormPage />} />
            <Route
              path={`${relative(V3_ROUTES.recurring)}/:id/edit`}
              element={<PaymentFormPage />}
            />
            <Route path={`${relative(V3_ROUTES.recurring)}/:peekId?`} element={<MoneyPage />} />
            <Route path={`${relative(V3_ROUTES.money)}/:peekId?`} element={<MoneyPage />} />
            <Route path={`${relative(V3_ROUTES.vendors)}/:peekId?`} element={<MoneyPage />} />

            {/* Capture (V3-14, completed by V3-44). The chooser itself is a
                sheet the shell owns, not a route: it opens over whatever screen
                the user is reading, so picking a method never costs them their
                place.

                Every destination behind it is a v3 screen now. The
                per-provider connect form is registered before the list for the
                same reason Money registers its form first — a provider key must
                not be reachable as anything but a provider key. */}
            <Route path={relative(V3_CAPTURE_ROUTES.manualEntry)} element={<ManualEntryPage />} />
            <Route
              path={relative(V3_CAPTURE_ROUTES.recordMovement)}
              element={<RecordMovementPage />}
            />
            <Route path={relative(V3_CAPTURE_ROUTES.fileImport)} element={<FileImportPage />} />
            <Route path={relative(V3_CAPTURE_ROUTES.walletImport)} element={<WalletImportPage />} />
            <Route
              path={relative(V3_CAPTURE_ROUTES.invoiceUpload)}
              element={<InvoiceUploadPage />}
            />
            <Route
              path={`${relative(V3_CAPTURE_ROUTES.integrations)}/:providerKey`}
              element={<IntegrationConnectPage />}
            />
            <Route path={relative(V3_CAPTURE_ROUTES.integrations)} element={<IntegrationsPage />} />

            {/* Files (V3-43). Registered *after* `invoiceUpload` above, which
                shares its segment: `documents/:documentId` would otherwise
                claim the word "upload" as an id. React Router ranks static over
                dynamic and would resolve it correctly either way, but the
                version switch reads `V3_ROUTE_PATTERNS`, whose `segmentsMatch`
                has no such rule — so the ordering here is documentation of a
                constraint that is enforced over there. */}
            <Route path={relative(V3_ROUTES.files)} element={<FilesPage />} />
            <Route
              path={`${relative(V3_ROUTES.files)}/:documentId`}
              element={<DocumentDetailPage />}
            />

            {/* v2's own name for the Files screen, kept as a redirect (SC-71
                5.2). Without it `/files` fell through to the catch-all below
                and became `/v2/files`, which v2 does not route either — so a
                stale bookmark or a link from before the rename landed on a
                blank `#root` with no header, no tab bar, no console error and
                no error boundary. In an installed PWA there is no URL bar, so
                there was no way out of it at all. The drawer already points at
                `/documents`; this is the address people had written down. */}
            <Route path="files" element={<Navigate to={V3_ROUTES.files} replace />} />

            {/* Settings (V3-43). A form surface, not a list, so no peek and no
                child route — everything it does happens in place. */}
            <Route path={relative(V3_ROUTES.settings)} element={<SettingsPage />} />

            {/* The remaining More destinations (V3-15).

                Three shapes, and which one a surface gets is the same question
                `V3DataViewConfig` asks: a record that is a handful of facts
                peeks, one with a screen's worth of interaction navigates.

                - Review peeks nothing: its rows are pointers to other surfaces.
                - Jobs, vaults and groups register a *named* child param,
                  because those are real pages rather than sheets over the list
                  — so the list does unmount, which is correct: you have left
                  it. Groups joined them in SC-70, when its member list became
                  editable in place.
                - The rest take the `:peekId?` optional child for the reason in
                  the kitchen-sink note above.

                Tokens registers `tokens/hidden` before `tokens/:peekId?` for
                the same reason Money registers the form first: the segment must
                not be reachable as an id, and static-over-dynamic ranking should
                not be the only thing enforcing it. */}
            {/* Registered BEFORE the feed's own route for the reason stated
                above: `transfers` is a segment, not a peek id, and
                static-over-dynamic ranking should not be the only thing
                enforcing it. The `:peekId?` child is what makes a transfer's
                sheet deep-linkable. */}
            {/* `answered` is a segment, not a transaction id (SC-181) —
                registered before the queue's `:peekId?` for the same reason
                `transfers` is registered before the feed's. */}
            <Route
              path={`${relative(TRANSFER_ANSWERED_PATH)}/:peekId?`}
              element={<AnsweredTransfersPage />}
            />
            {/* `rules` is a segment too (SC-375), and the same ordering rule
                applies to it. */}
            <Route path={relative(TRANSFER_RULES_PATH)} element={<TransferRulesPage />} />
            <Route
              path={`${relative(TRANSFER_REVIEW_PATH)}/:peekId?`}
              element={<TransfersReviewPage />}
            />
            {/* `balances` is a segment under Review, like `transfers` (SC-501),
                and registered before the feed's own route for the same
                reason. */}
            <Route path={relative(BALANCE_GAP_REVIEW_PATH)} element={<BalanceGapsReviewPage />} />
            <Route path={relative(V3_ROUTES.review)} element={<ReviewPage />} />
            <Route path={relative(V3_ROUTES.jobs)} element={<JobsPage />} />
            <Route path={`${relative(V3_ROUTES.jobs)}/:jobId`} element={<JobDetailPage />} />
            <Route path={`${relative(V3_ROUTES.accounts)}/:peekId?`} element={<AccountsPage />} />
            <Route
              path={`${relative(V3_ROUTES.institutions)}/:peekId?`}
              element={<InstitutionsPage />}
            />
            <Route path={relative(V3_ROUTES.vaults)} element={<VaultsPage />} />
            <Route path={`${relative(V3_ROUTES.vaults)}/:id`} element={<VaultDetailPage />} />
            <Route path={relative(V3_ROUTES.groups)} element={<GroupsPage />} />
            <Route path={relative(V3_ROUTES.entities)} element={<EntitiesPage />} />
            <Route path={`${relative(V3_ROUTES.groups)}/:id`} element={<GroupDetailPage />} />
            <Route
              path={`${relative(V3_ROUTES.tokens)}/hidden/:peekId?`}
              element={<TokensPage />}
            />
            <Route path={`${relative(V3_ROUTES.tokens)}/:peekId?`} element={<TokensPage />} />

            {/* The terminal 404, and it is terminal for the whole app (SC-423).

                This used to forward to `/v2/<same path>` on the assumption
                that v2 would show something — v2's own catch-all was the
                screen that actually answered, and it is the only reason an
                unrouted path was not a white page. Inside the layout route,
                not beside it, for the reason v2's carried: a layout route
                whose children all miss renders `null`, and in the installed
                PWA there is no address bar to leave a blank screen by (SC-62,
                SC-73). */}
            <Route path="*" element={<NotFoundPage location={location} />} />
          </Route>
        </Routes>
      </TooltipProvider>
    </V3ErrorBoundary>
  );
}

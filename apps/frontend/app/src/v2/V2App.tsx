import { TooltipProvider } from '@scani/ui/ui/tooltip';
import { Route, Routes } from 'react-router-dom';
import { V2ErrorBoundary } from './components/shared/V2ErrorBoundary';
import { AppShell } from './layouts/AppShell';
import { AccountDetailPage } from './pages/AccountDetailPage';
import { AccountsPage } from './pages/AccountsPage';
import { AddDataPage } from './pages/AddDataPage';
import { DashboardPage } from './pages/DashboardPage';
import { DocumentDetailPage } from './pages/DocumentDetailPage';
import { DocumentUploadPage } from './pages/DocumentUploadPage';
import { FileImportPage } from './pages/FileImportPage';
import { FilesPage } from './pages/FilesPage';
import { GroupsPage } from './pages/GroupsPage';
import { HoldingDetailPage } from './pages/HoldingDetailPage';
import { HoldingsPage } from './pages/HoldingsPage';
import { InstitutionDetailPage } from './pages/InstitutionDetailPage';
import { InstitutionsPage } from './pages/InstitutionsPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { JobsPage } from './pages/JobsPage';
import { ManualEntryPage } from './pages/ManualEntryPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PaymentCreatePage } from './pages/PaymentCreatePage';
import { PaymentDetailPage } from './pages/PaymentDetailPage';
import { PaymentsOverviewPage } from './pages/PaymentsOverviewPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { ReviewPage } from './pages/ReviewPage';
import { SettingsPage } from './pages/SettingsPage';
import { TokensPage } from './pages/TokensPage';
import { VaultDetailPage } from './pages/VaultDetailPage';
import { VaultsPage } from './pages/VaultsPage';
import { VendorDetailPage } from './pages/VendorDetailPage';
import { VendorsPage } from './pages/VendorsPage';
import { WalletImportPage } from './pages/WalletImportPage';

export function V2App() {
  return (
    <V2ErrorBoundary>
      {/* `RealtimeProvider` used to sit here. It now lives above the v2/v3
          split in `App.tsx` — v3 needs it too, and a hook that throws without
          it took the whole Holdings page down (SC-39). v2 receives exactly the
          same context from exactly one mount; only the depth changed. */}
      <TooltipProvider delayDuration={0}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="holdings" element={<HoldingsPage />} />
            <Route path="holdings/:id" element={<HoldingDetailPage />} />
            <Route path="accounts" element={<AccountsPage />} />
            <Route path="accounts/:id" element={<AccountDetailPage />} />
            <Route path="institutions" element={<InstitutionsPage />} />
            <Route path="institutions/:id" element={<InstitutionDetailPage />} />
            <Route path="groups" element={<GroupsPage />} />
            <Route path="vaults" element={<VaultsPage />} />
            <Route path="vaults/:id" element={<VaultDetailPage />} />
            <Route path="integrations" element={<IntegrationsPage />} />
            <Route path="import" element={<FileImportPage />} />
            <Route path="wallet-import" element={<WalletImportPage />} />
            <Route path="manual-entry" element={<ManualEntryPage />} />
            <Route path="add-data" element={<AddDataPage />} />
            <Route path="jobs" element={<JobsPage />} />
            <Route path="jobs/:jobId" element={<JobDetailPage />} />
            <Route path="review" element={<ReviewPage />} />
            <Route path="payments" element={<PaymentsOverviewPage />} />
            <Route path="payments/recurring" element={<PaymentsPage />} />
            <Route path="payments/recurring/new" element={<PaymentCreatePage />} />
            <Route path="payments/recurring/:id" element={<PaymentDetailPage />} />
            <Route path="payments/recurring/:id/edit" element={<PaymentCreatePage />} />
            <Route path="vendors" element={<VendorsPage />} />
            <Route path="vendors/:id" element={<VendorDetailPage />} />
            <Route path="documents" element={<FilesPage />} />
            <Route path="documents/upload" element={<DocumentUploadPage />} />
            <Route path="documents/:id" element={<DocumentDetailPage />} />
            <Route path="tokens" element={<TokensPage />} />
            <Route path="settings" element={<SettingsPage />} />
            {/* Inside the layout route, not beside it — the shell is the way
                out, and in the installed PWA it is the only one (SC-73). A
                layout route whose children all miss renders `null`, which is
                how every unrouted `/v2/*` path was a white page with no back
                button. */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </TooltipProvider>
    </V2ErrorBoundary>
  );
}

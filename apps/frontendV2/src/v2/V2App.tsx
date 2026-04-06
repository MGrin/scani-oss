import { Route, Routes } from 'react-router-dom';
import { AppShell } from './layouts/AppShell';
import { AccountDetailPage } from './pages/AccountDetailPage';
import { AccountsPage } from './pages/AccountsPage';
import { AddDataPage } from './pages/AddDataPage';
import { DashboardPage } from './pages/DashboardPage';
import { FileImportPage } from './pages/FileImportPage';
import { GroupsPage } from './pages/GroupsPage';
import { HoldingDetailPage } from './pages/HoldingDetailPage';
import { HoldingsPage } from './pages/HoldingsPage';
import { InstitutionDetailPage } from './pages/InstitutionDetailPage';
import { InstitutionsPage } from './pages/InstitutionsPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { SettingsPage } from './pages/SettingsPage';
import { VaultDetailPage } from './pages/VaultDetailPage';
import { VaultsPage } from './pages/VaultsPage';

export function V2App() {
  return (
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
        <Route path="add-data" element={<AddDataPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}

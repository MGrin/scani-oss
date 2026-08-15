import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { useTranslation } from 'react-i18next';
import { AccountSettings } from '../components/settings/AccountSettings';
import { DataExportSettings } from '../components/settings/DataExportSettings';
import { DataQualitySettings } from '../components/settings/DataQualitySettings';
import { MaintenanceSettings } from '../components/settings/MaintenanceSettings';
import { ProfileSettings } from '../components/settings/ProfileSettings';
import { SessionsSettings } from '../components/settings/SessionsSettings';

/**
 * Everything about the account rather than the portfolio.
 *
 * A form surface, so `PageLayout` at the `narrow` measure and `FieldSet`/`Field`
 * throughout — never `V3DataView`, even where a block happens to render a run
 * of rows. The blocks are ordered by how often anyone opens the page for them:
 * who you are and what currency you read in, then where you are signed in,
 * then the two diagnostic blocks, then leaving.
 *
 * Theme and the v2/v3 switch are deliberately absent. Both live in the shell —
 * the sidebar's footer on a desktop, the More drawer's on a phone — where they
 * are reachable from every screen, and a second copy here would be a second
 * control for the same state.
 */
export function SettingsPage() {
  const { t } = useTranslation();

  return (
    <PageLayout>
      <PageHeader title={t('settings.title')} />
      <p className="text-body text-muted-foreground">{t('settings.subtitle')}</p>

      <ProfileSettings />
      <SessionsSettings />
      <DataExportSettings />
      <MaintenanceSettings />
      <DataQualitySettings />
      <AccountSettings />
    </PageLayout>
  );
}

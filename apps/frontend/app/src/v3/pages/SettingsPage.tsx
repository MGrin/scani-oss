import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Bell, Bot, Database, UserRound, UserX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { AccountSettings } from '../components/settings/AccountSettings';
import { AgentsSections } from '../components/settings/AgentsSections';
import { BackupSettings } from '../components/settings/BackupSettings';
import { BillCalendarSettings } from '../components/settings/BillCalendarSettings';
import { CostBasisSettings } from '../components/settings/CostBasisSettings';
import { DataExportSettings } from '../components/settings/DataExportSettings';
import { DataQualitySettings } from '../components/settings/DataQualitySettings';
import { HouseholdSettings } from '../components/settings/HouseholdSettings';
import { MaintenanceSettings } from '../components/settings/MaintenanceSettings';
import { NotificationSettings } from '../components/settings/NotificationSettings';
import { ProfileSettings } from '../components/settings/ProfileSettings';
import { SecuritySettings } from '../components/settings/SecuritySettings';
import { SessionsSettings } from '../components/settings/SessionsSettings';
import { SettingsAreas } from '../components/settings/SettingsAreas';
import type { SettingsArea } from '../lib/settings-areas';

/** In the list's order: what a person changes most comes first. */
const AREAS: SettingsArea[] = [
  {
    id: 'you',
    icon: UserRound,
    titleKey: 'v3.settings.areas.you.title',
    sections: () => (
      <>
        <ProfileSettings />
        <CostBasisSettings />
      </>
    ),
  },
  {
    id: 'notifications',
    icon: Bell,
    titleKey: 'v3.settings.areas.notifications.title',
    sections: () => (
      <>
        <NotificationSettings />
        <SessionsSettings />
      </>
    ),
  },
  {
    id: 'agents',
    icon: Bot,
    titleKey: 'v3.settings.areas.agents.title',
    sections: () => <AgentsSections />,
  },
  {
    id: 'data',
    icon: Database,
    titleKey: 'v3.settings.areas.data.title',
    sections: () => (
      <>
        <DataExportSettings />
        <BackupSettings />
        <BillCalendarSettings />
        <HouseholdSettings />
        <DataQualitySettings />
        <MaintenanceSettings />
      </>
    ),
  },
  {
    id: 'account',
    icon: UserX,
    titleKey: 'v3.settings.areas.account.title',
    sections: () => (
      <>
        <SecuritySettings />
        <AccountSettings />
      </>
    ),
  },
];

/** Settings: the list of areas, and the area an address names (SC-1670). */
export function SettingsPage() {
  const { t } = useTranslation();
  const { area: areaId } = useParams();
  const area = AREAS.find((candidate) => candidate.id === areaId);
  useDocumentTitle(area ? t(area.titleKey) : t('settings.title'));

  return <SettingsAreas areas={AREAS} areaId={areaId} />;
}

import { useTranslation } from 'react-i18next';
import { AgentActivitySettings } from './AgentActivitySettings';
import { AgentCallsSettings } from './AgentCallsSettings';
import { AgentTokensSettings } from './AgentTokensSettings';
import { ConnectedAppsSettings } from './ConnectedAppsSettings';
import { useAgentsArea } from './useSettingsAreaValues';

/**
 * The AI agents area. Every section in it hides while it has nothing to show,
 * so an account with access off and nothing connected would get a title over
 * an empty page; it is told why instead.
 */
export function AgentsSections() {
  const { t } = useTranslation();
  const { empty } = useAgentsArea();
  return (
    <>
      {empty && (
        <p className="text-body text-muted-foreground">{t('v3.settings.areas.agents.off')}</p>
      )}
      <AgentTokensSettings />
      <ConnectedAppsSettings />
      <AgentActivitySettings />
      <AgentCallsSettings />
    </>
  );
}

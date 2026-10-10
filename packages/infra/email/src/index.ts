export { isDisposableEmail } from './disposable-domains';
export { EmailService } from './email-service';
export { LocalEmailService } from './local-email-service';
export {
  renderActivationNudgeEmail,
  renderContactReceivedEmail,
  renderHouseholdInviteEmail,
  renderIntegrationAlertEmail,
  renderTwoFactorResetEmail,
  renderWeeklyDigestEmail,
  type StaleIntegrationItem,
} from './templates';
export {
  type EmailMessage,
  SCANI_BRAND,
} from './types';

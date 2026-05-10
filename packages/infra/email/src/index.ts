export { type EmailConfig, loadEmailConfig, resetEmailConfig } from './config';
export { EmailService } from './email-service';
export { LocalEmailService } from './local-email-service';
export {
  renderMagicLinkEmail,
  renderOtpEmail,
  renderVerificationEmail,
  renderWaitlistJoinEmail,
} from './templates';
export { FastmailEmailService } from './transports/fastmail-email-service';
export { LoggingEmailService } from './transports/logging-email-service';
export { SmtpEmailService } from './transports/smtp-email-service';
export {
  type EmailBrand,
  type EmailContent,
  type EmailMessage,
  type OtpType,
  SCANI_BRAND,
  SCANI_CLOUD_BRAND,
} from './types';

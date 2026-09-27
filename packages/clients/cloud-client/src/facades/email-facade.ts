import { type EmailMessage, EmailService, LocalEmailService } from '@scani/email';
import { Container, Service } from 'typedi';
import { CloudEmailService } from '../cloud-services/cloud-email-service';
import { loadCloudClientConfig } from '../config';
import { getCloudClient } from '../runtime';

// Cloud-or-local dispatcher resolved via typedi. When SCANI_CLOUD_URL is
// set the message routes through the data-provider; otherwise it falls
// through to LocalEmailService (Fastmail / SMTP / logging picker).
@Service()
export class EmailFacade extends EmailService {
  // undefined = haven't checked; null = checked and no cloud client.
  private cachedCloud: CloudEmailService | null | undefined;

  override async sendOtp(input: Parameters<EmailService['sendOtp']>[0]): Promise<void> {
    if (loadCloudClientConfig().SCANI_DEPLOYMENT_TIER !== '2') return super.sendOtp(input);
    await this.customerClient().email.auth.mutate({
      kind: 'otp',
      to: input.to,
      code: input.code,
      type: input.type,
      language: input.language,
      appOrigin: this.appOrigin(input.brand),
    });
  }
  override async sendMagicLink(input: Parameters<EmailService['sendMagicLink']>[0]): Promise<void> {
    if (loadCloudClientConfig().SCANI_DEPLOYMENT_TIER !== '2') return super.sendMagicLink(input);
    await this.customerClient().email.auth.mutate({
      kind: 'magic-link',
      to: input.to,
      url: input.url,
      language: input.language,
      appOrigin: this.appOrigin(input.brand),
    });
  }
  override async sendVerificationEmail(
    input: Parameters<EmailService['sendVerificationEmail']>[0]
  ): Promise<void> {
    if (loadCloudClientConfig().SCANI_DEPLOYMENT_TIER !== '2')
      return super.sendVerificationEmail(input);
    await this.customerClient().email.auth.mutate({
      kind: 'verification',
      to: input.to,
      url: input.url,
      language: input.language,
      appOrigin: this.appOrigin(input.brand),
    });
  }
  private appOrigin(brand: Parameters<EmailService['sendOtp']>[0]['brand']): string {
    if (!brand) throw new Error('Tier 2 auth email requires the self-hosted application origin');
    return new URL(brand.appUrl).origin;
  }
  private customerClient() {
    const client = getCloudClient();
    if (!client) throw new Error('Tier 2 requires Scani Cloud credentials');
    return client;
  }

  protected async sendMessage(message: EmailMessage): Promise<void> {
    if (loadCloudClientConfig().SCANI_DEPLOYMENT_TIER === '2')
      throw new Error('Tier 2 only supports template-based auth email');
    const cloud = this.cloud();
    if (cloud) return cloud.send(message);
    return this.local().send(message);
  }

  private cloud(): CloudEmailService | null {
    if (this.cachedCloud !== undefined) return this.cachedCloud;
    if (loadCloudClientConfig().SCANI_DEPLOYMENT_TIER === '1') return null;
    const client = getCloudClient();
    this.cachedCloud = client ? new CloudEmailService(client) : null;
    return this.cachedCloud;
  }

  private local(): LocalEmailService {
    return Container.get(LocalEmailService);
  }
}

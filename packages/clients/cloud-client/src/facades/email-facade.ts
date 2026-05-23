import { type EmailMessage, EmailService, LocalEmailService } from '@scani/email';
import { Container, Service } from 'typedi';
import { CloudEmailService } from '../cloud-services/cloud-email-service';
import { getCloudClient } from '../runtime';

// Cloud-or-local dispatcher resolved via typedi. When SCANI_CLOUD_URL is
// set the message routes through the data-provider; otherwise it falls
// through to LocalEmailService (Fastmail / SMTP / logging picker).
@Service()
export class EmailFacade extends EmailService {
  // undefined = haven't checked; null = checked and no cloud client.
  private cachedCloud: CloudEmailService | null | undefined;

  protected async sendMessage(message: EmailMessage): Promise<void> {
    const cloud = this.cloud();
    if (cloud) return cloud.send(message);
    return this.local().send(message);
  }

  private cloud(): CloudEmailService | null {
    if (this.cachedCloud !== undefined) return this.cachedCloud;
    const client = getCloudClient();
    this.cachedCloud = client ? new CloudEmailService(client) : null;
    return this.cachedCloud;
  }

  private local(): LocalEmailService {
    return Container.get(LocalEmailService);
  }
}

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export type OtpType = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';

export interface EmailBrand {
  appName: string;
  appUrl: string;
  marketingUrl: string;
  supportAddress: string;
  from: string;
  accent: string;
  accentText: string;
  bodyBg: string;
  cardBg: string;
  textPrimary: string;
  textMuted: string;
  border: string;
}

export const SCANI_BRAND: EmailBrand = {
  appName: 'Scani',
  appUrl: 'https://app.example.com',
  marketingUrl: 'https://example.com',
  supportAddress: 'support@example.com',
  from: '"Scani" <welcome@example.com>',
  accent: '#111111',
  accentText: '#ffffff',
  bodyBg: '#f5f6f8',
  cardBg: '#ffffff',
  textPrimary: '#0f172a',
  textMuted: '#64748b',
  border: '#e2e8f0',
};

export const SCANI_CLOUD_BRAND: EmailBrand = {
  appName: 'Scani Cloud',
  appUrl: 'https://cloud.example.com',
  marketingUrl: 'https://example.com',
  supportAddress: 'cloud@example.com',
  from: '"Scani Cloud" <cloud@example.com>',
  accent: '#111111',
  accentText: '#ffffff',
  bodyBg: '#f5f6f8',
  cardBg: '#ffffff',
  textPrimary: '#0f172a',
  textMuted: '#64748b',
  border: '#e2e8f0',
};

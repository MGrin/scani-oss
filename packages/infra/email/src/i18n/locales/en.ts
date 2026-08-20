import type { EmailStrings } from '../strings';

/** The English letter — and the one every language without a bundle gets. */
export const en: EmailStrings = {
  lang: 'en',
  layout: {
    footer:
      "You're getting this email because someone requested sign-in to {appLink} using this address. If that wasn't you, you can safely ignore this message — no account action was taken.",
    tagline: 'Personal wealth, one place',
  },
  common: {
    orCopyUrl: 'Or copy and paste this URL into your browser:',
  },
  magicLink: {
    subject: 'Sign in to {app}',
    headline: 'Your sign-in link',
    body: 'Tap the button below to sign in to {app}. The link works once and expires in 15 minutes — open it in the same browser you started from.',
    button: 'Sign in to {app}',
    preheader: 'Your sign-in link for {app} — expires in 15 minutes.',
    textIntro: 'Sign in to {app}.',
    textBody:
      'Open this link in the same browser you started from. It works once and expires in 15 minutes.',
    textIgnore: "Didn't request this? You can ignore this email safely.",
  },
  otp: {
    headline: {
      signIn: 'Your sign-in code',
      emailVerification: 'Verify your email',
      forgetPassword: 'Reset your password',
      changeEmail: 'Confirm your new email',
    },
    purpose: {
      signIn: 'Enter this code in {app} to finish signing in.',
      emailVerification: 'Enter this code to verify your email on {app}.',
      forgetPassword: 'Enter this code to continue resetting your password on {app}.',
      changeEmail: 'Enter this code to confirm your new email on {app}.',
    },
    subjectPurpose: {
      signIn: 'your sign-in code',
      emailVerification: 'verify your email',
      forgetPassword: 'reset your password',
      changeEmail: 'confirm your new email',
    },
    expiryHtml: 'It works once and expires in 5 minutes.',
    expiryText:
      "This code works once and expires in 5 minutes. If you didn't request it, ignore this email.",
    codeLabel: 'Code: {code}',
    tapCode: 'Tap the code to select it, then paste it into {app} on the device you started from.',
    preheaderSignIn: '{code} is your {app} sign-in code (expires in 5 min).',
    preheaderVerification: '{code} is your {app} verification code (expires in 5 min).',
  },
  verification: {
    subject: 'Verify your email — {app}',
    headline: 'Confirm your email',
    body: 'You just signed up for {app}. Tap the button below to confirm we can reach you at this address.',
    button: 'Verify email',
    preheader: 'Confirm your email address for {app}.',
    textWelcome: 'Welcome to {app}.',
    textBody:
      'Click the link below to confirm {app} can reach you at this address. The link works once.',
    textIgnore: "Didn't sign up for {app}? You can ignore this email safely.",
  },
};

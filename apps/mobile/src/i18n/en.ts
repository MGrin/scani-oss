const en = {
  common: {
    ok: 'OK!',
    cancel: 'Cancel',
    back: 'Back',
  },
  welcomeScreen: {
    postscript:
      'Почему у человека грустное ебало? Он не болен, не калека — просто заебало. Заебало не по-детски как порой бывало, а серьёзно, блядь, пиздецки, нахуй — заебало. Головой об стену бъётся человек в печали... Не смеётся, не ебётся... О как заебали...',
    readyForLaunch: 'Your app, almost ready for launch!',
    exciting: '(ohh, this is exciting!)',
  },
  errorScreen: {
    title: 'Something went wrong!',
    friendlySubtitle:
      "This is the screen that your users will see in production when an error is thrown. You'll want to customize this message (located in `app/i18n/en.ts`) and probably the layout as well (`app/screens/ErrorScreen`). If you want to remove this entirely, check `app/app.tsx` for the <ErrorBoundary> component.",
    reset: 'RESET APP',
  },
  emptyStateComponent: {
    generic: {
      heading: 'So empty... so sad',
      content: 'No data found yet. Try clicking the button to refresh or reload the app.',
      button: "Let's try this again",
    },
  },
  auth: {
    welcome: 'Welcome to Scani',
    welcomeToScani: 'Welcome!',
    signIn: 'Sign In',
    enterEmail: 'Enter your email to sign in or create an account',
    emailLabel: 'Email',
    emailPlaceholder: 'your@email.com',
    continueWithEmail: 'Continue with Email',
    sendingCode: 'Sending verification code...',
    checkYourEmail: 'Check your email',
    codeSent: "We've sent a code to {{email}}.\nThis code will expire in 10 minutes.",
    enterCode: 'Enter verification code',
    enterCodeDescription: 'Enter the 6-digit code from your email',
    verifyCode: 'Verify Code',
    resendCode: 'Resend Code',
    resendCodeIn: 'Resend Code ({{seconds}}s)',
    useDifferentEmail: 'Use a different email',
    codeExpires: 'The code expires in 10 minutes',
    newAccount: 'New to Scani?\nYour account will be created automatically.',
  },
  home: {
    title: 'Welcome to Scani',
    signedInAs: 'Signed in as',
    userId: 'User ID',
    memberSince: 'Member since',
    signOut: 'Sign Out',
    confirmSignOut: 'Are you sure you want to sign out?',
    signingOut: 'Signing out...',
  },
};

export default en;
export type Translations = typeof en;

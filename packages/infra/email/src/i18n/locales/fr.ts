import type { EmailStrings } from '../strings';

/**
 * The French letter (SC-761).
 *
 * Addressed as « vous » throughout, matching the app's own `fr.json`: French
 * has no neutral second person the way English does, and a product writing to
 * someone it has not met uses « vous ».
 *
 * The OTP subject is assembled as `{code} — {subjectPurpose} · {app}`, so those
 * four strings are noun phrases rather than sentences — « votre code de
 * connexion », not « connectez-vous ».
 */
export const fr: EmailStrings = {
  lang: 'fr',
  dir: 'ltr',
  layout: {
    footer:
      'Vous recevez cet e-mail parce que quelqu’un a demandé à se connecter à {appLink} avec cette adresse. Si ce n’était pas vous, vous pouvez ignorer ce message sans risque — aucune action n’a été effectuée sur le compte.',
    tagline: 'Votre patrimoine, en un seul endroit',
  },
  common: {
    orCopyUrl: 'Ou copiez-collez ce lien dans votre navigateur :',
  },
  magicLink: {
    subject: 'Connexion à {app}',
    headline: 'Votre lien de connexion',
    body: 'Appuyez sur le bouton ci-dessous pour vous connecter à {app}. Le lien ne fonctionne qu’une seule fois et expire dans 15 minutes — ouvrez-le dans le navigateur depuis lequel vous avez commencé.',
    button: 'Se connecter à {app}',
    preheader: 'Votre lien de connexion à {app} — expire dans 15 minutes.',
    textIntro: 'Connectez-vous à {app}.',
    textBody:
      'Ouvrez ce lien dans le navigateur depuis lequel vous avez commencé. Il ne fonctionne qu’une seule fois et expire dans 15 minutes.',
    textIgnore: 'Vous n’avez rien demandé ? Vous pouvez ignorer cet e-mail sans risque.',
  },
  householdInvite: {
    subject: '{inviter} vous invite à rejoindre un foyer sur {app}',
    headline: 'Rejoindre {household}',
    body: '{inviter} vous invite à voir les comptes partagés dans {household} sur {app}. Vos propres comptes restent privés, sauf si vous choisissez de les partager.',
    button: "Accepter l'invitation",
    preheader: '{inviter} vous invite à rejoindre {household} sur {app}.',
    textIntro: '{inviter} vous invite à rejoindre {household} sur {app}.',
    textBody:
      'Connectez-vous avec cette adresse e-mail, puis acceptez. Vos propres comptes restent privés, sauf si vous les partagez.',
    expiry: "L'invitation expire dans 7 jours.",
  },
  otp: {
    headline: {
      signIn: 'Votre code de connexion',
      emailVerification: 'Vérifiez votre adresse e-mail',
      forgetPassword: 'Réinitialisez votre mot de passe',
      changeEmail: 'Confirmez votre nouvelle adresse',
    },
    purpose: {
      signIn: 'Saisissez ce code dans {app} pour terminer la connexion.',
      emailVerification: 'Saisissez ce code pour vérifier votre adresse e-mail sur {app}.',
      forgetPassword:
        'Saisissez ce code pour poursuivre la réinitialisation de votre mot de passe sur {app}.',
      changeEmail: 'Saisissez ce code pour confirmer votre nouvelle adresse sur {app}.',
    },
    subjectPurpose: {
      signIn: 'votre code de connexion',
      emailVerification: 'vérification de votre adresse e-mail',
      forgetPassword: 'réinitialisation du mot de passe',
      changeEmail: 'confirmation de votre nouvelle adresse',
    },
    expiryHtml: 'Il ne fonctionne qu’une seule fois et expire dans 5 minutes.',
    expiryText:
      'Ce code ne fonctionne qu’une seule fois et expire dans 5 minutes. Si vous ne l’avez pas demandé, ignorez cet e-mail.',
    codeLabel: 'Code : {code}',
    tapCode:
      'Appuyez sur le code pour le sélectionner, puis collez-le dans {app} sur l’appareil depuis lequel vous avez commencé.',
    preheaderSignIn: '{code} est votre code de connexion {app} (expire dans 5 min).',
    preheaderVerification: '{code} est votre code de vérification {app} (expire dans 5 min).',
  },
  verification: {
    subject: 'Vérifiez votre adresse e-mail — {app}',
    headline: 'Confirmez votre adresse e-mail',
    body: 'Vous venez de créer un compte {app}. Appuyez sur le bouton ci-dessous pour confirmer que nous pouvons vous joindre à cette adresse.',
    button: 'Vérifier l’adresse',
    preheader: 'Confirmez votre adresse e-mail pour {app}.',
    textWelcome: 'Bienvenue sur {app}.',
    textBody:
      'Cliquez sur le lien ci-dessous pour confirmer que {app} peut vous joindre à cette adresse. Le lien ne fonctionne qu’une seule fois.',
    textIgnore:
      'Vous n’avez pas créé de compte {app} ? Vous pouvez ignorer cet e-mail sans risque.',
  },
  activationNudge: {
    subject: 'Ajoutez votre premier compte à {app}',
    preheader:
      "Connectez une plateforme d'échange, un portefeuille ou un relevé bancaire, et {app} commence le suivi.",
    greeting: 'Bonjour {name},',
    greetingNoName: 'Bonjour,',
    headline: 'Ajoutez votre premier compte',
    body: "Vous vous êtes inscrit à {app} il y a quelques jours et n'avez encore rien ajouté. Connectez une plateforme d'échange ou un portefeuille, importez un relevé bancaire ou saisissez un solde : {app} tiendra ensuite votre patrimoine net et vos rendements à jour.",
    button: 'Ouvrir {app}',
    once: "C'est le seul rappel que nous vous enverrons.",
    footer:
      'Vous recevez ce message une seule fois parce que vous vous êtes inscrit à {appLink}. {unsubscribeLink} : un clic, sans connexion. Comment nous traitons vos données : {privacyLink}.',
    unsubscribe: 'Ne plus recevoir ces e-mails',
    privacy: 'politique de confidentialité',
    textOpen: 'Ouvrir {app} : {url}',
    textUnsubscribe: 'Ne plus recevoir ces e-mails : {url}',
    textPrivacy: 'Politique de confidentialité : {url}',
  },
};

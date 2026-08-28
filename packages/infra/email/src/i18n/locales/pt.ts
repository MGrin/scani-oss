import type { EmailStrings } from '../strings';

/**
 * The European Portuguese letter (SC-761).
 *
 * Written in the impersonal third person — «Clique», «o seu navegador» — with
 * no pronoun of address at all, which is what pt-PT consumer products use.
 * That is a third register beside the two already here: Spanish picked «tú»
 * because «usted» reads as institutional distance, French has to use « vous »
 * for want of a neutral, and Portuguese has a neutral that is neither — the
 * verb carries the courtesy and «você» is simply left out.
 *
 * European rather than Brazilian throughout, matching `LANGUAGE_FORMATS.pt`,
 * which resolves this language's dates and numbers to `PT`. The words that
 * diverge in this file are «ligação» (BR: «link») and «palavra-passe»
 * (BR: «senha»).
 *
 * The OTP subject is assembled as `{code} — {subjectPurpose} · {app}`, so those
 * four strings are noun phrases rather than sentences — «o seu código de
 * acesso», not «inicie sessão».
 */
export const pt: EmailStrings = {
  lang: 'pt',
  layout: {
    footer:
      'Recebe esta mensagem porque alguém pediu para iniciar sessão em {appLink} com este endereço. Se não foi você, pode ignorá-la sem problema — não foi feito nada na conta.',
    tagline: 'O seu património, num só sítio',
  },
  common: {
    orCopyUrl: 'Ou copie e cole esta ligação no seu navegador:',
  },
  magicLink: {
    subject: 'Início de sessão em {app}',
    headline: 'A sua ligação de acesso',
    body: 'Clique no botão abaixo para iniciar sessão em {app}. A ligação só funciona uma vez e caduca dentro de 15 minutos — abra-a no navegador onde começou.',
    button: 'Iniciar sessão em {app}',
    preheader: 'A sua ligação de acesso a {app} — caduca dentro de 15 minutos.',
    textIntro: 'Inicie sessão em {app}.',
    textBody:
      'Abra esta ligação no navegador onde começou. Só funciona uma vez e caduca dentro de 15 minutos.',
    textIgnore: 'Não pediu nada? Pode ignorar esta mensagem sem problema.',
  },
  otp: {
    headline: {
      signIn: 'O seu código de acesso',
      emailVerification: 'Confirme o seu endereço de correio',
      forgetPassword: 'Reponha a sua palavra-passe',
      changeEmail: 'Confirme o seu novo endereço',
    },
    purpose: {
      signIn: 'Introduza este código em {app} para terminar o início de sessão.',
      emailVerification: 'Introduza este código para confirmar o seu endereço de correio em {app}.',
      forgetPassword:
        'Introduza este código para continuar a reposição da sua palavra-passe em {app}.',
      changeEmail: 'Introduza este código para confirmar o seu novo endereço em {app}.',
    },
    subjectPurpose: {
      signIn: 'o seu código de acesso',
      emailVerification: 'confirmação do seu endereço de correio',
      forgetPassword: 'reposição da palavra-passe',
      changeEmail: 'confirmação do seu novo endereço',
    },
    expiryHtml: 'Só funciona uma vez e caduca dentro de 5 minutos.',
    expiryText:
      'Este código só funciona uma vez e caduca dentro de 5 minutos. Se não o pediu, ignore esta mensagem.',
    codeLabel: 'Código: {code}',
    tapCode: 'Toque no código para o selecionar e cole-o em {app} no dispositivo onde começou.',
    preheaderSignIn: '{code} é o seu código de acesso a {app} (caduca em 5 min).',
    preheaderVerification: '{code} é o seu código de confirmação de {app} (caduca em 5 min).',
  },
  verification: {
    subject: 'Confirme o seu endereço de correio — {app}',
    headline: 'Confirme o seu endereço de correio',
    body: 'Acabou de criar uma conta {app}. Clique no botão abaixo para confirmar que o podemos contactar neste endereço.',
    button: 'Confirmar o endereço',
    preheader: 'Confirme o seu endereço de correio para {app}.',
    textWelcome: 'Bem-vindo ao {app}.',
    textBody:
      'Clique na ligação abaixo para confirmar que {app} o pode contactar neste endereço. A ligação só funciona uma vez.',
    textIgnore: 'Não criou nenhuma conta {app}? Pode ignorar esta mensagem sem problema.',
  },
};

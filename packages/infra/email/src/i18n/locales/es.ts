import type { EmailStrings } from '../strings';

/**
 * The Spanish letter (SC-761).
 *
 * Addressed as «tú» throughout, matching the app's own `es.json`. This is the
 * one place Spanish and French diverge on register: French has no neutral
 * second person and a product writing to a stranger uses « vous », while
 * Spanish consumer products in Spain overwhelmingly use «tú» — «usted» reads
 * as institutional distance rather than as courtesy.
 *
 * The OTP subject is assembled as `{code} — {subjectPurpose} · {app}`, so those
 * four strings are noun phrases rather than sentences — «tu código de acceso»,
 * not «inicia sesión».
 */
export const es: EmailStrings = {
  lang: 'es',
  layout: {
    footer:
      'Recibes este correo porque alguien ha pedido iniciar sesión en {appLink} con esta dirección. Si no has sido tú, puedes ignorar este mensaje sin problema — no se ha hecho nada en la cuenta.',
    tagline: 'Tu patrimonio, en un solo sitio',
  },
  common: {
    orCopyUrl: 'O copia y pega este enlace en tu navegador:',
  },
  magicLink: {
    subject: 'Inicio de sesión en {app}',
    headline: 'Tu enlace de acceso',
    body: 'Pulsa el botón de abajo para iniciar sesión en {app}. El enlace solo funciona una vez y caduca en 15 minutos — ábrelo en el navegador desde el que empezaste.',
    button: 'Iniciar sesión en {app}',
    preheader: 'Tu enlace de acceso a {app} — caduca en 15 minutos.',
    textIntro: 'Inicia sesión en {app}.',
    textBody:
      'Abre este enlace en el navegador desde el que empezaste. Solo funciona una vez y caduca en 15 minutos.',
    textIgnore: '¿No has pedido nada? Puedes ignorar este correo sin problema.',
  },
  otp: {
    headline: {
      signIn: 'Tu código de acceso',
      emailVerification: 'Verifica tu dirección de correo',
      forgetPassword: 'Restablece tu contraseña',
      changeEmail: 'Confirma tu nueva dirección',
    },
    purpose: {
      signIn: 'Introduce este código en {app} para terminar de iniciar sesión.',
      emailVerification: 'Introduce este código para verificar tu dirección de correo en {app}.',
      forgetPassword:
        'Introduce este código para continuar con el restablecimiento de tu contraseña en {app}.',
      changeEmail: 'Introduce este código para confirmar tu nueva dirección en {app}.',
    },
    subjectPurpose: {
      signIn: 'tu código de acceso',
      emailVerification: 'verificación de tu dirección de correo',
      forgetPassword: 'restablecimiento de la contraseña',
      changeEmail: 'confirmación de tu nueva dirección',
    },
    expiryHtml: 'Solo funciona una vez y caduca en 5 minutos.',
    expiryText:
      'Este código solo funciona una vez y caduca en 5 minutos. Si no lo has pedido, ignora este correo.',
    codeLabel: 'Código: {code}',
    tapCode:
      'Pulsa el código para seleccionarlo y pégalo en {app} en el dispositivo desde el que empezaste.',
    preheaderSignIn: '{code} es tu código de acceso a {app} (caduca en 5 min).',
    preheaderVerification: '{code} es tu código de verificación de {app} (caduca en 5 min).',
  },
  verification: {
    subject: 'Verifica tu dirección de correo — {app}',
    headline: 'Confirma tu dirección de correo',
    body: 'Acabas de crear una cuenta de {app}. Pulsa el botón de abajo para confirmar que podemos localizarte en esta dirección.',
    button: 'Verificar la dirección',
    preheader: 'Confirma tu dirección de correo para {app}.',
    textWelcome: 'Te damos la bienvenida a {app}.',
    textBody:
      'Haz clic en el enlace de abajo para confirmar que {app} puede localizarte en esta dirección. El enlace solo funciona una vez.',
    textIgnore: '¿No has creado ninguna cuenta de {app}? Puedes ignorar este correo sin problema.',
  },
};

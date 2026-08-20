import type { EmailStrings } from '../strings';

/**
 * The Russian letter (SC-412).
 *
 * Addressed as «вы» lowercase throughout — the neutral register the app's own
 * `ru.json` settled on, and the one a product writes to a person it has not
 * met. Nothing here is capitalised for emphasis: «Вы» capitalised is a
 * formal-letter convention that reads as stiff in an interface.
 */
export const ru: EmailStrings = {
  lang: 'ru',
  layout: {
    footer:
      'Вы получили это письмо, потому что кто-то запросил вход в {appLink} с этого адреса. Если это были не вы, просто проигнорируйте письмо — с аккаунтом ничего не произошло.',
    tagline: 'Личные финансы в одном месте',
  },
  common: {
    orCopyUrl: 'Или скопируйте эту ссылку в браузер:',
  },
  magicLink: {
    subject: 'Вход в {app}',
    headline: 'Ваша ссылка для входа',
    body: 'Нажмите кнопку ниже, чтобы войти в {app}. Ссылка сработает один раз и действует 15 минут — откройте её в том же браузере, где вы начали.',
    button: 'Войти в {app}',
    preheader: 'Ваша ссылка для входа в {app} — действует 15 минут.',
    textIntro: 'Вход в {app}.',
    textBody:
      'Откройте эту ссылку в том же браузере, где вы начали. Она сработает один раз и действует 15 минут.',
    textIgnore: 'Не запрашивали вход? Это письмо можно спокойно проигнорировать.',
  },
  otp: {
    headline: {
      signIn: 'Ваш код для входа',
      emailVerification: 'Подтвердите адрес почты',
      forgetPassword: 'Сброс пароля',
      changeEmail: 'Подтвердите новый адрес',
    },
    purpose: {
      signIn: 'Введите этот код в {app}, чтобы завершить вход.',
      emailVerification: 'Введите этот код, чтобы подтвердить адрес почты в {app}.',
      forgetPassword: 'Введите этот код, чтобы продолжить сброс пароля в {app}.',
      changeEmail: 'Введите этот код, чтобы подтвердить новый адрес почты в {app}.',
    },
    subjectPurpose: {
      signIn: 'ваш код для входа',
      emailVerification: 'подтверждение адреса почты',
      forgetPassword: 'сброс пароля',
      changeEmail: 'подтверждение нового адреса',
    },
    expiryHtml: 'Он сработает один раз и действует 5 минут.',
    expiryText:
      'Код сработает один раз и действует 5 минут. Если вы его не запрашивали, просто проигнорируйте письмо.',
    codeLabel: 'Код: {code}',
    tapCode:
      'Нажмите на код, чтобы выделить его, и вставьте в {app} на том устройстве, где вы начали.',
    preheaderSignIn: '{code} — ваш код для входа в {app} (действует 5 минут).',
    preheaderVerification: '{code} — ваш код подтверждения в {app} (действует 5 минут).',
  },
  verification: {
    subject: 'Подтвердите адрес почты — {app}',
    headline: 'Подтвердите адрес почты',
    body: 'Вы зарегистрировались в {app}. Нажмите кнопку ниже, чтобы подтвердить, что мы можем писать вам на этот адрес.',
    button: 'Подтвердить адрес',
    preheader: 'Подтвердите адрес почты для {app}.',
    textWelcome: 'Добро пожаловать в {app}.',
    textBody:
      'Откройте ссылку ниже, чтобы подтвердить, что {app} может писать вам на этот адрес. Ссылка сработает один раз.',
    textIgnore: 'Не регистрировались в {app}? Это письмо можно спокойно проигнорировать.',
  },
};

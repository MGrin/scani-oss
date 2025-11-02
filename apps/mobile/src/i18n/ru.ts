import { Translations } from "./en"

const ru: Translations = {
  common: {
    ok: "OK",
    cancel: "Отмена",
    back: "Назад",
  },
  welcomeScreen: {
    postscript:
      "Почему у человека грустное ебало? Он не болен, не калека — просто заебало. Заебало не по-детски как порой бывало, а серьёзно, блядь, пиздецки, нахуй — заебало. Головой об стену бъётся человек в печали... Не смеётся, не ебётся... О как заебали...",
    readyForLaunch: "Ваше приложение почти готово к запуску!",
    exciting: "(о, это захватывающе!)",
  },
  errorScreen: {
    title: "Что-то пошло не так!",
    friendlySubtitle:
      "Это экран, который ваши пользователи увидят в продакшене при возникновении ошибки. Вы захотите настроить это сообщение (расположено в `app/i18n/ru.ts`) и, вероятно, макет (`app/screens/ErrorScreen`). Если вы хотите полностью удалить это, проверьте `app/app.tsx` для компонента <ErrorBoundary>.",
    reset: "СБРОСИТЬ ПРИЛОЖЕНИЕ",
  },
  emptyStateComponent: {
    generic: {
      heading: "Так пусто... так грустно",
      content:
        "Данных пока не найдено. Попробуйте нажать кнопку, чтобы обновить или перезагрузить приложение.",
      button: "Давайте попробуем еще раз",
    },
  },
  auth: {
    welcome: "Добро пожаловать в Scani",
    welcomeToScani: "Добро пожаловать в Scani",
    signIn: "Войти",
    enterEmail: "Введите email для входа или создания аккаунта",
    emailLabel: "Email",
    emailPlaceholder: "Введите ваш email",
    continueWithEmail: "Продолжить с Email",
    sendingCode: "Отправляем код подтверждения...",
    checkYourEmail: "Проверьте почту",
    codeSent: "Мы отправили код на {{email}}.\nЭтот код действителен 10 минут.",
    enterCode: "Введите код подтверждения",
    enterCodeDescription: "Введите 6-значный код из письма",
    verifyCode: "Подтвердить код",
    resendCode: "Отправить снова",
    resendCodeIn: "Отправить снова ({{seconds}}с)",
    useDifferentEmail: "Использовать другой email",
    codeExpires: "Код действителен 10 минут",
    newAccount: "Новый пользователь? Ваш аккаунт будет создан автоматически.",
  },
  home: {
    title: "Добро пожаловать в Scani",
    signedInAs: "Вход выполнен как",
    userId: "ID пользователя",
    memberSince: "Участник с",
    signOut: "Выйти",
    confirmSignOut: "Вы уверены, что хотите выйти?",
    signingOut: "Выход...",
  },
}

export default ru


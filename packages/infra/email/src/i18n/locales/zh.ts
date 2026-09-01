import type { EmailStrings } from '../strings';

export const zh: EmailStrings = {
  lang: 'zh',
  layout: {
    footer:
      '你收到这封邮件，是因为有人用这个地址请求登录 {appLink}。如果不是你本人操作，可以放心忽略这封邮件——账户没有发生任何变化。',
    tagline: '个人财富，一处尽览',
  },
  common: {
    orCopyUrl: '或者复制下面的网址并粘贴到浏览器中打开：',
  },
  magicLink: {
    subject: '登录 {app}',
    headline: '你的登录链接',
    body: '点击下方按钮即可登录 {app}。该链接只能使用一次，15 分钟后过期——请在你发起操作的同一个浏览器中打开。',
    button: '登录 {app}',
    preheader: '这是你的 {app} 登录链接，15 分钟后过期。',
    textIntro: '登录 {app}。',
    textBody: '请在你发起操作的同一个浏览器中打开这个链接。它只能使用一次，15 分钟后过期。',
    textIgnore: '不是你发起的？可以放心忽略这封邮件。',
  },
  otp: {
    headline: {
      signIn: '你的登录验证码',
      emailVerification: '验证你的邮箱',
      forgetPassword: '重置你的密码',
      changeEmail: '确认你的新邮箱',
    },
    purpose: {
      signIn: '在 {app} 中输入这个验证码即可完成登录。',
      emailVerification: '输入这个验证码以验证你在 {app} 的邮箱。',
      forgetPassword: '输入这个验证码以继续重置你在 {app} 的密码。',
      changeEmail: '输入这个验证码以确认你在 {app} 的新邮箱。',
    },
    subjectPurpose: {
      signIn: '你的登录验证码',
      emailVerification: '验证你的邮箱',
      forgetPassword: '重置你的密码',
      changeEmail: '确认你的新邮箱',
    },
    expiryHtml: '它只能使用一次，5 分钟后过期。',
    expiryText: '这个验证码只能使用一次，5 分钟后过期。如果不是你请求的，请忽略这封邮件。',
    codeLabel: '验证码：{code}',
    tapCode: '点按验证码将其选中，然后粘贴到你发起操作的那台设备上的 {app} 中。',
    preheaderSignIn: '{code} 是你的 {app} 登录验证码（5 分钟后过期）。',
    preheaderVerification: '{code} 是你的 {app} 验证码（5 分钟后过期）。',
  },
  verification: {
    subject: '验证你的邮箱 — {app}',
    headline: '确认你的邮箱',
    body: '你刚刚注册了 {app}。点击下方按钮，确认我们可以通过这个地址联系到你。',
    button: '验证邮箱',
    preheader: '请确认你在 {app} 使用的邮箱地址。',
    textWelcome: '欢迎使用 {app}。',
    textBody: '点击下面的链接，确认 {app} 可以通过这个地址联系到你。该链接只能使用一次。',
    textIgnore: '不是你注册的 {app}？可以放心忽略这封邮件。',
  },
};

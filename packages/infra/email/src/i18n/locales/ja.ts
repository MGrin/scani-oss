import type { EmailStrings } from '../strings';

export const ja: EmailStrings = {
  lang: 'ja',
  dir: 'ltr',
  layout: {
    footer:
      'このメールは、どなたかがこのアドレスで {appLink} へのサインインをリクエストしたためにお送りしています。心当たりがない場合は、そのまま破棄していただいて問題ありません。アカウントには何の操作も行われていません。',
    tagline: '個人の資産を、ひとつの場所に',
  },
  common: {
    orCopyUrl: 'または、次のURLをコピーしてブラウザに貼り付けてください:',
  },
  magicLink: {
    subject: '{app} にサインイン',
    headline: 'サインイン用リンク',
    body: '下のボタンをタップすると {app} にサインインできます。このリンクは一度だけ有効で、15分で期限が切れます。操作を開始したものと同じブラウザで開いてください。',
    button: '{app} にサインイン',
    preheader: '{app} のサインイン用リンクです。15分で期限が切れます。',
    textIntro: '{app} にサインインします。',
    textBody:
      '操作を開始したものと同じブラウザでこのリンクを開いてください。一度だけ有効で、15分で期限が切れます。',
    textIgnore: 'お心当たりがない場合は、このメールを破棄していただいて問題ありません。',
  },
  otp: {
    headline: {
      signIn: 'サインイン用コード',
      emailVerification: 'メールアドレスの確認',
      forgetPassword: 'パスワードの再設定',
      changeEmail: '新しいメールアドレスの確認',
    },
    purpose: {
      signIn: 'このコードを {app} に入力すると、サインインが完了します。',
      emailVerification: 'このコードを入力して、{app} のメールアドレスを確認してください。',
      forgetPassword: 'このコードを入力して、{app} のパスワード再設定を続けてください。',
      changeEmail: 'このコードを入力して、{app} の新しいメールアドレスを確認してください。',
    },
    subjectPurpose: {
      signIn: 'サインイン用コード',
      emailVerification: 'メールアドレスの確認',
      forgetPassword: 'パスワードの再設定',
      changeEmail: '新しいメールアドレスの確認',
    },
    expiryHtml: '一度だけ有効で、5分で期限が切れます。',
    expiryText:
      'このコードは一度だけ有効で、5分で期限が切れます。お心当たりがない場合は、このメールを破棄してください。',
    codeLabel: 'コード: {code}',
    tapCode: 'コードをタップして選択し、操作を開始した端末の {app} に貼り付けてください。',
    preheaderSignIn: '{code} は {app} のサインイン用コードです（5分で期限切れ）。',
    preheaderVerification: '{code} は {app} の確認用コードです（5分で期限切れ）。',
  },
  verification: {
    subject: 'メールアドレスの確認 — {app}',
    headline: 'メールアドレスの確認',
    body: '{app} にご登録いただきました。下のボタンをタップして、このアドレスで連絡できることをご確認ください。',
    button: 'メールアドレスを確認',
    preheader: '{app} のメールアドレスをご確認ください。',
    textWelcome: '{app} へようこそ。',
    textBody:
      '下のリンクをクリックして、{app} がこのアドレスで連絡できることをご確認ください。このリンクは一度だけ有効です。',
    textIgnore: '{app} に登録した覚えがない場合は、このメールを破棄していただいて問題ありません。',
  },
  activationNudge: {
    subject: '{app} に最初の口座を追加しましょう',
    preheader: '取引所、ウォレット、銀行ファイルをつなぐと、{app} が記録を始めます。',
    greeting: '{name} さん',
    greetingNoName: 'こんにちは',
    headline: '最初の口座を追加しましょう',
    body: '数日前に {app} に登録されましたが、まだ何も追加されていません。取引所やウォレットを接続する、銀行の明細を取り込む、残高を入力する、のいずれかを行えば、その後は {app} が純資産とリターンを最新の状態に保ちます。',
    button: '{app} を開く',
    once: 'このお知らせをお送りするのは今回限りです。',
    footer:
      '{appLink} にご登録いただいたため、このメールを一度だけお送りしています。{unsubscribeLink}（ワンクリック、ログイン不要）。データの取り扱いについて：{privacyLink}。',
    unsubscribe: 'このメールの配信を停止',
    privacy: 'プライバシーポリシー',
    textOpen: '{app} を開く: {url}',
    textUnsubscribe: 'このメールの配信を停止: {url}',
    textPrivacy: 'プライバシーポリシー: {url}',
  },
};

import type { EmailStrings } from '../strings';

/**
 * The Arabic letter (SC-201).
 *
 * Formal MSA, second person, and gender-neutral throughout: buttons and
 * instructions are verbal nouns («تسجيل الدخول إلى {app}», «يُرجى الضغط…»)
 * rather than imperatives, which in Arabic must choose a gender the sign-up
 * form never asked for. Second-person past («بدأت», «لم تطلب») and the ـك
 * possessive are neutral as long as nothing is vocalised, so they are left
 * bare. Digits stay Western, matching the `-nu-latn` pin the interface uses;
 * «تأكيد» carries both verify and confirm, because the تحقّق root is reserved
 * for realized gains.
 *
 * **The letter is still laid out left-to-right.** `layout.ts` emits
 * `<html lang>` and no `dir`, so this bundle renders Arabic text in an
 * unmirrored frame. That is deliberate sequencing rather than an oversight:
 * `ar` is held out of the app's language picker (`offered-languages.ts`), so
 * nothing can select it and no Arabic letter can be sent until the
 * right-to-left pass wires `dir` here and in the app.
 */
export const ar: EmailStrings = {
  lang: 'ar',
  layout: {
    footer:
      'وصلتك هذه الرسالة لأن أحدهم طلب تسجيل الدخول إلى {appLink} باستخدام هذا العنوان. إن لم يكن هذا الطلب منك، فيمكنك تجاهل الرسالة بأمان — لم يُتخذ أي إجراء على حسابك.',
    tagline: 'ثروتك الشخصية في مكان واحد',
  },
  common: {
    orCopyUrl: 'أو يمكنك نسخ هذا الرابط ولصقه في المتصفح:',
  },
  magicLink: {
    subject: 'تسجيل الدخول إلى {app}',
    headline: 'رابطك لتسجيل الدخول',
    body: 'يُرجى الضغط على الزر أدناه لتسجيل الدخول إلى {app}. الرابط صالح لمرة واحدة وتنتهي صلاحيته خلال 15 دقيقة — ويلزم فتحه في المتصفح نفسه الذي بدأت منه.',
    button: 'تسجيل الدخول إلى {app}',
    preheader: 'رابطك لتسجيل الدخول إلى {app} — تنتهي صلاحيته خلال 15 دقيقة.',
    textIntro: 'تسجيل الدخول إلى {app}.',
    textBody:
      'يُرجى فتح هذا الرابط في المتصفح نفسه الذي بدأت منه. وهو صالح لمرة واحدة وتنتهي صلاحيته خلال 15 دقيقة.',
    textIgnore: 'لم تطلب ذلك؟ يمكنك تجاهل هذه الرسالة بأمان.',
  },
  otp: {
    headline: {
      signIn: 'رمزك لتسجيل الدخول',
      emailVerification: 'تأكيد بريدك الإلكتروني',
      forgetPassword: 'إعادة تعيين كلمة المرور',
      changeEmail: 'تأكيد بريدك الإلكتروني الجديد',
    },
    purpose: {
      signIn: 'يُرجى إدخال هذا الرمز في {app} لإتمام تسجيل الدخول.',
      emailVerification: 'يُرجى إدخال هذا الرمز لتأكيد بريدك الإلكتروني في {app}.',
      forgetPassword: 'يُرجى إدخال هذا الرمز لمتابعة إعادة تعيين كلمة المرور في {app}.',
      changeEmail: 'يُرجى إدخال هذا الرمز لتأكيد بريدك الإلكتروني الجديد في {app}.',
    },
    subjectPurpose: {
      signIn: 'رمز تسجيل الدخول',
      emailVerification: 'تأكيد البريد الإلكتروني',
      forgetPassword: 'إعادة تعيين كلمة المرور',
      changeEmail: 'تأكيد البريد الإلكتروني الجديد',
    },
    // Opens with a conjunction because `templates/otp.ts` concatenates it onto
    // `purpose` inside one paragraph; `expiryText` stands alone and does not.
    expiryHtml: 'وهو صالح لمرة واحدة وتنتهي صلاحيته خلال 5 دقائق.',
    expiryText:
      'هذا الرمز صالح لمرة واحدة وتنتهي صلاحيته خلال 5 دقائق. إن لم تطلبه، يُرجى تجاهل هذه الرسالة.',
    codeLabel: 'الرمز: {code}',
    tapCode: 'يُرجى الضغط على الرمز لتحديده، ثم لصقه في {app} على الجهاز الذي بدأت منه.',
    preheaderSignIn: '{code} هو رمز تسجيل الدخول إلى {app} (تنتهي صلاحيته خلال 5 دقائق).',
    preheaderVerification: '{code} هو رمز التأكيد في {app} (تنتهي صلاحيته خلال 5 دقائق).',
  },
  verification: {
    subject: 'تأكيد بريدك الإلكتروني — {app}',
    headline: 'تأكيد بريدك الإلكتروني',
    body: 'لقد سجّلت للتو في {app}. يُرجى الضغط على الزر أدناه لتأكيد إمكانية الوصول إليك على هذا العنوان.',
    button: 'تأكيد البريد الإلكتروني',
    preheader: 'يُرجى تأكيد عنوان بريدك الإلكتروني لدى {app}.',
    textWelcome: 'مرحبًا بك في {app}.',
    textBody:
      'يُرجى النقر على الرابط أدناه لتأكيد إمكانية وصول {app} إليك على هذا العنوان. الرابط صالح لمرة واحدة.',
    textIgnore: 'لم تسجّل في {app}؟ يمكنك تجاهل هذه الرسالة بأمان.',
  },
};

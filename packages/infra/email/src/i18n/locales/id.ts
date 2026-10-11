import type { EmailStrings } from '../strings';

/**
 * Indonesian has one plural category and no grammatical gender, so every
 * sentence here reads the same whatever the count — nothing in this letter
 * needs a variant the type cannot express.
 *
 * Second person is `Anda` throughout, the formal register a bank or a broker
 * writes in. `kamu` is the other choice and it is the wrong one for a letter
 * about somebody's money.
 */
export const id: EmailStrings = {
  lang: 'id',
  dir: 'ltr',
  layout: {
    footer:
      'Anda menerima email ini karena ada yang meminta akses masuk ke {appLink} menggunakan alamat ini. Jika itu bukan Anda, abaikan saja pesan ini — tidak ada tindakan apa pun yang dilakukan pada akun.',
    tagline: 'Kekayaan pribadi, dalam satu tempat',
  },
  common: {
    orCopyUrl: 'Atau salin dan tempelkan URL ini ke peramban Anda:',
  },
  magicLink: {
    subject: 'Masuk ke {app}',
    headline: 'Tautan masuk Anda',
    body: 'Ketuk tombol di bawah untuk masuk ke {app}. Tautan ini hanya bisa dipakai sekali dan kedaluwarsa dalam 15 menit — buka di peramban yang sama dengan tempat Anda memulainya.',
    button: 'Masuk ke {app}',
    preheader: 'Tautan masuk Anda untuk {app} — kedaluwarsa dalam 15 menit.',
    textIntro: 'Masuk ke {app}.',
    textBody:
      'Buka tautan ini di peramban yang sama dengan tempat Anda memulainya. Tautan ini hanya bisa dipakai sekali dan kedaluwarsa dalam 15 menit.',
    textIgnore: 'Bukan Anda yang meminta ini? Abaikan saja email ini.',
  },
  householdInvite: {
    subject: '{inviter} mengundang Anda ke rumah tangga di {app}',
    headline: 'Bergabung dengan {household}',
    body: '{inviter} mengundang Anda untuk melihat akun yang dibagikan di {household} di {app}. Akun Anda sendiri tetap pribadi kecuali Anda memilih untuk membagikannya.',
    button: 'Terima undangan',
    preheader: '{inviter} mengundang Anda ke {household} di {app}.',
    textIntro: '{inviter} mengundang Anda ke {household} di {app}.',
    textBody:
      'Masuk dengan alamat email ini, lalu terima undangan. Akun Anda tetap pribadi kecuali Anda membagikannya.',
    expiry: 'Undangan berlaku selama 7 hari.',
  },
  otp: {
    headline: {
      signIn: 'Kode masuk Anda',
      emailVerification: 'Verifikasi email Anda',
      forgetPassword: 'Atur ulang kata sandi Anda',
      changeEmail: 'Konfirmasi email baru Anda',
    },
    purpose: {
      signIn: 'Masukkan kode ini di {app} untuk menyelesaikan proses masuk.',
      emailVerification: 'Masukkan kode ini untuk memverifikasi email Anda di {app}.',
      forgetPassword:
        'Masukkan kode ini untuk melanjutkan pengaturan ulang kata sandi Anda di {app}.',
      changeEmail: 'Masukkan kode ini untuk mengonfirmasi email baru Anda di {app}.',
    },
    subjectPurpose: {
      signIn: 'kode masuk Anda',
      emailVerification: 'verifikasi email Anda',
      forgetPassword: 'atur ulang kata sandi Anda',
      changeEmail: 'konfirmasi email baru Anda',
    },
    expiryHtml: 'Kode ini hanya bisa dipakai sekali dan kedaluwarsa dalam 5 menit.',
    expiryText:
      'Kode ini hanya bisa dipakai sekali dan kedaluwarsa dalam 5 menit. Jika bukan Anda yang memintanya, abaikan email ini.',
    codeLabel: 'Kode: {code}',
    tapCode:
      'Ketuk kodenya untuk memilihnya, lalu tempelkan ke {app} di perangkat tempat Anda memulai.',
    preheaderSignIn: '{code} adalah kode masuk {app} Anda (kedaluwarsa dalam 5 menit).',
    preheaderVerification: '{code} adalah kode verifikasi {app} Anda (kedaluwarsa dalam 5 menit).',
  },
  verification: {
    subject: 'Verifikasi email Anda — {app}',
    headline: 'Konfirmasi email Anda',
    body: 'Anda baru saja mendaftar di {app}. Ketuk tombol di bawah untuk mengonfirmasi bahwa kami bisa menghubungi Anda di alamat ini.',
    button: 'Verifikasi email',
    preheader: 'Konfirmasi alamat email Anda untuk {app}.',
    textWelcome: 'Selamat datang di {app}.',
    textBody:
      'Klik tautan di bawah untuk mengonfirmasi bahwa {app} bisa menghubungi Anda di alamat ini. Tautan ini hanya bisa dipakai sekali.',
    textIgnore: 'Bukan Anda yang mendaftar di {app}? Abaikan saja email ini.',
  },
  activationNudge: {
    subject: 'Tambahkan akun pertama Anda ke {app}',
    preheader: 'Hubungkan bursa, dompet, atau file bank, dan {app} mulai melacak.',
    greeting: 'Halo {name},',
    greetingNoName: 'Halo,',
    headline: 'Tambahkan akun pertama Anda',
    body: 'Anda mendaftar di {app} beberapa hari lalu dan belum menambahkan apa pun. Hubungkan bursa atau dompet, impor rekening koran bank, atau ketik saldo, dan {app} akan menjaga kekayaan bersih dan imbal hasil Anda tetap terbaru sejak itu.',
    button: 'Buka {app}',
    once: 'Ini satu-satunya pengingat yang akan kami kirim.',
    footer:
      'Anda menerima ini satu kali karena Anda mendaftar di {appLink}. {unsubscribeLink}, satu klik, tanpa masuk. Cara kami menangani data Anda: {privacyLink}.',
    unsubscribe: 'Berhenti menerima email ini',
    privacy: 'kebijakan privasi',
    textOpen: 'Buka {app}: {url}',
    textUnsubscribe: 'Berhenti menerima email ini: {url}',
    textPrivacy: 'Kebijakan privasi: {url}',
  },
};

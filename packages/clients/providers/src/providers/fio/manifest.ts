import type { IntegrationManifest } from '../../core/integration-manifest';

export const fioManifest: IntegrationManifest = {
  providerKey: 'fio',
  institutionName: 'Fio banka',
  defaultAccountTypeCode: 'checking',
  // Fio lets a customer hand the token to someone else, at the customer's
  // risk: "Klient je vždy odpovědný za způsobenou škodu v souvislosti s
  // použitím tokenu pro službu API třetí osobou" (VSP IB čl. XIII odst. 4).
  // Hosted use would likely also need a Czech account-information licence.
  // Quoted on SC-1732.
  selfHostedOnly: true,
  // A token may enter payment orders but not authorise them: "zadávat pokyny
  // k úhradě (ne však takové pokyny autorizovat)" (VSP IB čl. XIII odst. 1).
  credentialCanMoveMoney: false,
  // "Výpis z účtu je možné … vygenerovat ve formátech *.csv a *.gpc" (Fio's
  // internetbanking FAQ). Scani imports CSV and not GPC.
  statementExportFormats: ['CSV'],
  credentialNoun: 'token',
  // "nelze založit token bez doby platnosti nebo platnosti delší jak 180 dní"
  // (API document, chapter 2).
  credentialLifetimeDays: 180,
  credentialFields: [
    {
      name: 'token',
      label: 'API token',
      type: 'password',
      sensitive: true,
      required: true,
      hint: 'Internetbanking → Nastavení → API',
    },
  ],
  instructions: {
    steps: [
      'In Fio internetbanking, open Nastavení → API and add a token',
      'Choose "Sledování účtu" (account monitoring only)',
      'Confirm by SMS or push notification, then copy the token',
    ],
    note: 'A token covers one account and lasts at most 180 days, unless you let it renew each time you log in. Movements older than 90 days need an unlock in internetbanking first.',
    docsUrl: 'https://www.fio.cz/bank-services/internetbanking-api',
  },
};

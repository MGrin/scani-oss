# Statement fixtures

Each file is an example a bank published for implementers, taken from the
bank's own document on 2026-10-11. The names, accounts and references in them
are the bank's dummy data; none is a real customer's.

| Fixture | Format | Source |
|---|---|---|
| `mt940-ing-nl.sta` | MT940, SWIFT envelope, `/CODE/` subfields in `:86:` | ING, *Sample Files NL MT940*: <https://assets.ing.com/m/33b5fb41d9d72026/original/Sample-Files-MT940.pdf> |
| `mt940-raiffeisenbank-cz.sta` | MT940, `?NN` subfields in `:86:` | Raiffeisenbank CZ, *MT940 data structure*, section 4: <https://www.rb.cz/attachments/elektronicke-bankovnictvi/17372_RB_RFB-MT940-Data-structure_ENG_nahled.pdf> |
| `camt053-ing-nl.xml` | camt.053.001.02 | ING, *Sample Files NL CAMT.053*: <https://assets.ing.com/m/19ba05999348c5c7/original/Sample-Files-CAMT.pdf> |
| `camt053-mbank-pl.xml` | camt.053.001.08 | mBank, *Description of the camt.053.001.08 daily statement file format*, section 9.1: <https://www.mbank.pl/pdf/msp-korporacje/bankowosc-elektroniczna/description-of-the-camt.053.001.08-daily-statement-file-format.pdf> |

The banks publish these as PDF, so each fixture is the example's text with
the PDF's page numbers, headers and line wraps removed. Nothing else was
changed, with two exceptions: mBank prints two alternative `<BkTxCd>` layouts
side by side, and the fixture keeps the first ("ISO+MT94x"); and mBank's
message id lost the `MX-` before its digits, which the mirror's
internal-reference check reads as a work-tracker key.

Two of them do not add up, and that is the bank's doing: both ING samples
were cut down to a few entries while the closing balance stayed. The tests
use that. A parser must still read the entries and the stated closing
balance, and say that the lines do not reach it.

## Spreadsheets (SC-1734)

No bank publishes a sample XLSX or XLS export, so these come from open-source
importers that model a bank's export with made-up data. None is the bank's
own file, and none holds a real customer's data.

| Fixture | Format | Source |
|---|---|---|
| `xlsx-intesa-it.xlsx` | XLSX: metadata rows above the header, real date cells, signed amounts | Intesa Sanpaolo "Lista Operazioni", synthetic, from [danielededo/cashato](https://github.com/danielededo/cashato/blob/accd6bb07bbd617405a603b4acd7c0645530730e/demo/intesa_lista_operazioni_13m.xlsx) (MIT) |
| `xlsx-cib-cn.xlsx` | XLSX: every cell stored as text, separate out/in columns, a footer note | Industrial Bank (兴业银行) debit card export, synthetic, from [deb-sig/double-entry-generator](https://github.com/deb-sig/double-entry-generator/blob/97a4f653347dcacfc383580ab00d78d7e8eeda8f/example/cib_debit/example-cib_debit-cny-records.xlsx) (Apache-2.0, unchanged) |
| `xls-html-webank-it.xls` | an HTML table served as `.xls`, decimal commas | Webank "movimentiConto", synthetic, from [danielededo/cashato](https://github.com/danielededo/cashato/blob/accd6bb07bbd617405a603b4acd7c0645530730e/demo/other_banks/webank_movimentiConto.xls) (MIT) |
| `xls-spreadsheetml-synthetic.xls` | XML Spreadsheet 2003 served as `.xls`, an empty first sheet, an `ss:Index` gap | written for these tests from Microsoft's XML Spreadsheet schema; no bank is modelled |

A true binary `.xls` (an OLE compound file) is not read, so its test builds
the eight-byte OLE signature itself rather than carrying a file.

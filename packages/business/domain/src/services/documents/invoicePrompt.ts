/**
 * Invoice-extraction prompt, as a code constant.
 *
 * Deliberate choice for a solo project with a fast deploy path: a prompt
 * change is a one-file diff that goes through the same PR review as any
 * other behaviour change, rather than a value hiding in a database row or
 * an env var that can drift from what's actually deployed.
 *
 * `PROMPT_VERSION` gets stamped onto every `document_extractions` row
 * `InvoiceExtractionService` produces (see `documentExtractions.promptVersion`).
 * Bump it whenever `INVOICE_EXTRACTION_PROMPT` changes so a bad batch of
 * extractions is traceable to the exact prompt text that produced it —
 * without this, "the AI got worse" has no way to distinguish a model
 * regression from a wording tweak we shipped ourselves.
 */

export const PROMPT_VERSION = 'invoice-extraction-v3';

/**
 * Shared between the text path (`parseDocumentText(markdown, hint)`) and
 * the vision path (`parseScreenshot({ ..., hint })`) — the JSON contract
 * the model must produce is identical either way; only the payload
 * (markdown vs image bytes) differs, and that's chosen by the caller.
 *
 * `totalAmount` / `quantity` / `unitPrice` / `amount` are called out as
 * STRINGS explicitly: a model that emits `19.99` as a JSON number instead
 * of `"19.99"` as a JSON string is indistinguishable from correct at a
 * glance, but every downstream consumer treats these fields as
 * Decimal.js-parseable text, never a float.
 */
export const INVOICE_EXTRACTION_PROMPT = `You are extracting structured invoice data from a vendor document
(an invoice, receipt, or bill). The document may contain more than one
invoice — extract every one you find, not just the first.

Respond with ONLY a JSON object of this exact shape:

{
  "invoices": [
    {
      "vendorNameRaw": string,       // the vendor/merchant name as printed, verbatim
      "invoiceNumber": string | null,
      "issueDate": string | null,    // ISO 8601 date, "YYYY-MM-DD"
      "dueDate": string | null,      // ISO 8601 date, "YYYY-MM-DD"
      "totalAmount": string | null,  // decimal AS A STRING, e.g. "19.99" — never a JSON number
      "currencyCode": string | null, // ISO 4217, e.g. "USD"
      "paymentStatus": string | null,  // "paid" | "unpaid" | null
      "billingPeriod": string | null,  // "week" | "month" | "quarter" | "year" | null
      "confidence": number,          // 0.0-1.0, your confidence in this extraction
      "lineItems": [
        {
          "description": string,
          "quantity": string | null,   // decimal AS A STRING
          "unitPrice": string | null,  // decimal AS A STRING
          "amount": string | null      // decimal AS A STRING
        }
      ]
    }
  ]
}

Rules:
- Every monetary value ("totalAmount", "quantity", "unitPrice", "amount")
  MUST be a JSON string, not a JSON number. Do not round or reformat the
  number beyond stripping currency symbols and thousands separators.
- If a field is not present on the document, use null rather than
  guessing.
- "issueDate" is the date the document itself was issued — labelled
  "Invoice date", "Issue date", or just "Date". A receipt that shows no
  issue date of its own is issued on the date it records a payment
  ("Date paid", "Date of payment", "Paid on", "paid on <date>"): use that.
  Do not return null for a receipt merely because no label says "issue".
- "dueDate" is the payment deadline, and ONLY where the document states
  one ("Due date", "Payment due", "Pay by"; "Due on receipt" means the
  same date as "issueDate"). If the document states no deadline,
  "dueDate" is null — never derive one from payment terms, and never
  copy "issueDate" into it as a stand-in.
- A service or billing period ("Service period", "Jul 1 – Jul 31, 2026",
  "Aug 10–Sep 10, 2026") is NEITHER date. Ignore those ranges when
  filling "issueDate" and "dueDate", even when they are the most
  prominent dates on the page.
- Emit both dates as "YYYY-MM-DD". Translate month names from any
  language ("15 augustus 2026", "15. August 2026", "15 авг. 2026 г.")
  and resolve a two-digit year to the century the rest of the document
  sits in.
- For an all-numeric date, decide day-vs-month order from the document's
  own evidence — the vendor's or the customer's country, the currency,
  the language of the labels — not from a default. European documents
  write DD/MM/YYYY. If both orders yield a real date and the document
  offers no such evidence, return null rather than picking one: a wrong
  date is worse than a missing one.
- A date you cannot read off the document is null. Do not estimate one
  from the filename, from the other dates, or from today.
- "paymentStatus" is "paid" ONLY when the document itself shows the
  invoice as already settled — a "PAID" / "payment received" stamp or
  label, a recorded payment method or card last-4, a receipt/confirmation
  header, or a balance due of zero. It is "unpaid" when the document
  shows an amount still owed (a non-zero balance due, "please pay by",
  payment instructions with no payment recorded). If the document does
  not make it clear either way, use null — do NOT infer "paid" from the
  document merely being a receipt-shaped PDF.
- "billingPeriod" is the recurrence of the CHARGE, not the length of the
  document's date range: "annual"/"yearly"/"per year"/"12 months" ->
  "year", "monthly"/"per month" -> "month", "quarterly" -> "quarter",
  "weekly" -> "week". A one-off purchase with no stated recurrence is
  null. If the document does not state a billing period, use null.
- If the document holds no recognizable invoice, return
  {"invoices": []}.
- Do not include any text outside the JSON object.`;

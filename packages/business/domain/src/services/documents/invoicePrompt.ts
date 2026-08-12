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

export const PROMPT_VERSION = 'invoice-extraction-v2';

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

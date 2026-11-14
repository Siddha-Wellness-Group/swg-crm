# SWG Receipts Robot

Every day, it finds new subscription receipts in Gmail, saves them as PDFs in Drive, logs them in a sheet, and emails them to Daniel.

| Vendor | Gmail search used |
|---|---|
| Claude (Anthropic) | `from:anthropic (receipt OR invoice OR payment)` |
| Base44 | `from:base44 (receipt OR invoice OR payment)` |
| Google Workspace | `from:payments-noreply@google.com "Google Workspace"` |
| GitHub | `from:github.com (receipt OR "payment receipt" OR invoice)` |

## Install (5 minutes, one time)

Do this while logged in to the Google account that **receives the billing emails**.

1. Go to <https://script.google.com> → **New project**. Name it `SWG Receipts Robot`.
2. Delete the sample code, paste all of [`Code.gs`](./Code.gs), save.
3. ⚙️ **Project Settings** → set **Time zone** to `Asia/Jerusalem`.
4. Pick `dryRun` in the function dropdown → **Run** → approve permissions.
   Check **Execution log**: it lists the receipts it found. Nothing is sent.
5. Pick `setup` → **Run**. This:
   - creates Drive folder `SWG Receipts/` with monthly subfolders (`2026-11/` …)
   - creates the sheet `SWG Receipts Log` inside it
   - adds a daily trigger (~09:00)
   - does a first run, sending receipts from the **last 45 days** to Daniel.

Done. It never sends the same receipt twice (the log sheet remembers every email ID).

## Change something

All settings are in `CONFIG` at the top of `Code.gs`:

- **Recipient**: `RECIPIENT`
- **New subscription**: add a line to `VENDORS` with a name + Gmail search. Test the search in the Gmail search bar first.
- **A receipt was missed**: open the receipt email, check the sender address, and adjust that vendor's `query`.

## Notes

- If the vendor attaches a PDF, that PDF is used. Otherwise the email itself is printed to PDF.
- The amount is read from the email automatically (best effort). If it shows `—`, fill it in on the log sheet.
- To stop it: script.google.com → ⏰ **Triggers** → delete `processReceipts`.

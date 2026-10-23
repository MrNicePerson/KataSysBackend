# KataSys: 100-case user misuse audit

Date: 23 October 2026 (Asia/Karachi)

## Result

100 deterministic user misuse/edge cases were actually executed against the production-branch business logic, using synthetic local data. Baseline: **76 passed, 24 failed**. After fixes: **100 passed, 0 failed**. The 24 failures are test scenarios, not 24 independently verified security vulnerabilities.

Additional verification: **89 backend tests passed**, including 7 real HTTP assertions plus their parent test, permission checks, and isolated local MongoDB receiving/recovery persistence tests. **107 frontend tests passed**. Production build passed using Vite 8.3.5. npm audit reports 0 known vulnerabilities in each repository after compatible dependency patches (frontend previously had 2 high-severity dependency findings). These dependency findings are additional to the 24 failed business-logic scenarios.

No production API mutations, real customer records, or live database changes were used for this audit. HTTP tests use a temporary database named codex_adversarial_http_<process>_<timestamp> and clean up only that database.

Baseline source revisions: backend 8882ec7; frontend 7266978.

## Fixes applied

| Finding | Cases | Fix |
|---|---|---|
| Product/account names could be blanked | 019, 040 | Reject empty trimmed names on update. |
| User-supplied product ID could collide with existing stock | 020 | Generated record IDs override input IDs. |
| Unknown return types/conditions accepted | 026, 027 | Validate refund and condition choices before stock/account changes. |
| Discounted sale could refund its full undiscounted price | 029 | Allocate original bill discount to returned lines; cumulative cent rounding keeps partial returns consistent. Update return and exchange previews. |
| Unsupported expense payment method accepted | 036 | Whitelist supported payment methods. |
| Invalid cheque party/direction and blank identifiers accepted | 044–047 | Validate party/direction and require cheque number and bank. |
| Impossible dates accepted by JavaScript date rollover | 048, 058, 064, 065, 096 | Strict ISO calendar-date round trip validation across dated mutations. Cheque dates cannot be silently removed. |
| Negative bounce charges accepted | 050 | Validate finite nonnegative charge amount. |
| Unknown daily-record type interpreted as closing | 068 | Only explicit opening/closing types accepted. |
| Backup could import negative stock or invalid balances | 079, 080 | Check restored stock counts, reservation limits, costs/prices and account balances before accepting backup. |
| Invalid or already settled installments corrupted payment progress | 095, 097, 098, 100 | Reject zero-value plans, overpayment, completed-plan payment and unsettled cheque payments; cap schedule count at 1200. |

A pre-existing frontend test imported a developer-specific sibling backend checkout. It now imports this repository's local business logic so the test suite runs without that external checkout. Existing cheque regression fixtures now provide the newly required number/bank; date assertion accepts the stricter validation message.

## All 100 attempted cases

Most rows assert that an invalid operation produces a validation error, leaves the source database unchanged, and does not crash with TypeError/RangeError. The specifically named valid/retry cases assert their accounting or stock invariant instead.

| ID | Area | User attempt / invariant tested | Before | After |
|---|---|---|---|---|
| 001 | Sales | Empty sale | PASS | PASS |
| 002 | Sales | Negative sale quantity | PASS | PASS |
| 003 | Sales | Fractional sale quantity | PASS | PASS |
| 004 | Sales | Missing stock reference | PASS | PASS |
| 005 | Sales | Oversell available stock | PASS | PASS |
| 006 | Sales | Duplicate lines oversell stock | PASS | PASS |
| 007 | Sales | Negative price | PASS | PASS |
| 008 | Sales | Discount exceeds bill | PASS | PASS |
| 009 | Sales | Cash overpayment | PASS | PASS |
| 010 | Sales | Cash plus cheque overpayment | PASS | PASS |
| 011 | Stock | Negative initial stock | PASS | PASS |
| 012 | Stock | Fractional initial stock | PASS | PASS |
| 013 | Stock | Blank product name | PASS | PASS |
| 014 | Stock | Duplicate product batch and size | PASS | PASS |
| 015 | Stock | Negative product cost | PASS | PASS |
| 016 | Stock | Infinite product price | PASS | PASS |
| 017 | Stock | Remove more stock than exists | PASS | PASS |
| 018 | Stock | Invalid stock direction | PASS | PASS |
| 019 | Stock | Rename product to blank | FAIL | PASS |
| 020 | Stock | Client supplied product ID collision | FAIL | PASS |
| 021 | Returns | Return without original sale | PASS | PASS |
| 022 | Returns | Return wrong invoice line | PASS | PASS |
| 023 | Returns | Negative return quantity | PASS | PASS |
| 024 | Returns | Fractional return quantity | PASS | PASS |
| 025 | Returns | Return exceeds sold quantity | PASS | PASS |
| 026 | Returns | Unknown refund type | FAIL | PASS |
| 027 | Returns | Unknown return condition | FAIL | PASS |
| 028 | Returns | Repeated return exceeds remaining invoice quantity | PASS | PASS |
| 029 | Returns | Discounted full return cannot refund more than original invoice | FAIL | PASS |
| 030 | Returns | Rejected return leaves source state untouched | PASS | PASS |
| 031 | Payments | Zero payment | PASS | PASS |
| 032 | Payments | Negative payment | PASS | PASS |
| 033 | Payments | NaN payment | PASS | PASS |
| 034 | Payments | Missing payment account | PASS | PASS |
| 035 | Payments | Unsupported payment method | PASS | PASS |
| 036 | Payments | Unsupported expense method | FAIL | PASS |
| 037 | Payments | Zero expense | PASS | PASS |
| 038 | Payments | Duplicate bulk recovery customer | PASS | PASS |
| 039 | Payments | Bulk recovery exceeds debt | PASS | PASS |
| 040 | Payments | Rename account to blank | FAIL | PASS |
| 041 | Cheques | Zero cheque | PASS | PASS |
| 042 | Cheques | Negative cheque | PASS | PASS |
| 043 | Cheques | Missing cheque customer | PASS | PASS |
| 044 | Cheques | Invalid cheque party type | FAIL | PASS |
| 045 | Cheques | Invalid cheque direction | FAIL | PASS |
| 046 | Cheques | Blank cheque number | FAIL | PASS |
| 047 | Cheques | Blank cheque bank | FAIL | PASS |
| 048 | Cheques | Impossible cheque due date | FAIL | PASS |
| 049 | Cheques | Clearing the same cheque twice only credits once | PASS | PASS |
| 050 | Cheques | Negative bounce charges rejected | FAIL | PASS |
| 051 | Banks | Blank bank name | PASS | PASS |
| 052 | Banks | Duplicate bank name | PASS | PASS |
| 053 | Banks | Negative bank opening amount | PASS | PASS |
| 054 | Banks | Transfer to same account | PASS | PASS |
| 055 | Banks | Transfer to missing account | PASS | PASS |
| 056 | Banks | Negative transfer | PASS | PASS |
| 057 | Banks | Zero transfer | PASS | PASS |
| 058 | Banks | Impossible transfer date | FAIL | PASS |
| 059 | Banks | Invalid bank balance | PASS | PASS |
| 060 | Banks | Inactive transfer source | PASS | PASS |
| 061 | Closing | Closing without opening | PASS | PASS |
| 062 | Closing | Closing pending due cheque | PASS | PASS |
| 063 | Closing | Closing cheque under clearing | PASS | PASS |
| 064 | Closing | Invalid daily record date | FAIL | PASS |
| 065 | Closing | Impossible daily record date | FAIL | PASS |
| 066 | Closing | Negative opening cash | PASS | PASS |
| 067 | Closing | Negative counted cash | PASS | PASS |
| 068 | Closing | Unknown daily record type | FAIL | PASS |
| 069 | Closing | Sale without business-day opening | PASS | PASS |
| 070 | Closing | Staff overwrites saved daily opening | PASS | PASS |
| 071 | Backup | Unsupported backup version | PASS | PASS |
| 072 | Backup | Missing products collection | PASS | PASS |
| 073 | Backup | Duplicate product IDs | PASS | PASS |
| 074 | Backup | Null product row | PASS | PASS |
| 075 | Backup | Product without ID | PASS | PASS |
| 076 | Backup | Dangling sale customer | PASS | PASS |
| 077 | Backup | Dangling sale product | PASS | PASS |
| 078 | Backup | Dangling bank transaction | PASS | PASS |
| 079 | Backup | Negative stock backup | FAIL | PASS |
| 080 | Backup | Invalid numeric customer balance | FAIL | PASS |
| 081 | Held orders | Empty held order | PASS | PASS |
| 082 | Held orders | Invalid held order kind | PASS | PASS |
| 083 | Held orders | Negative held quantity | PASS | PASS |
| 084 | Held orders | Fractional held quantity | PASS | PASS |
| 085 | Held orders | Held order oversells stock | PASS | PASS |
| 086 | Held orders | Missing held stock item | PASS | PASS |
| 087 | Held orders | Duplicate held lines overreserve stock | PASS | PASS |
| 088 | Held orders | Release unknown held order | PASS | PASS |
| 089 | Held orders | Cannot sell reserved stock | PASS | PASS |
| 090 | Held orders | Releasing reservation restores availability once | PASS | PASS |
| 091 | Installments | Missing installment customer | PASS | PASS |
| 092 | Installments | Negative installment total | PASS | PASS |
| 093 | Installments | Zero installment count | PASS | PASS |
| 094 | Installments | Fractional installment count | PASS | PASS |
| 095 | Installments | Zero installment total | FAIL | PASS |
| 096 | Installments | Impossible installment start date | FAIL | PASS |
| 097 | Installments | Installment overpayment | FAIL | PASS |
| 098 | Installments | Cheque installment does not count as paid before clearance | FAIL | PASS |
| 099 | Installments | Schedule amounts sum to total after rounding | PASS | PASS |
| 100 | Installments | Completed plan cannot accept another payment | FAIL | PASS |

## Reproduce

From the backend checkout, run npm run test:audit. This executes all 100 cases and writes adversarial-after-fixes.json. The preserved adversarial-baseline.json is the measured pre-fix result; do not overwrite it when rerunning against fixed code.

The HTTP test is test/adversarialHttp.integration.test.js. It requires a local MongoDB listener at 127.0.0.1:27017. It reports a skip if that listener is unavailable. It ran without skips during this audit.

## Scope and practical limits

This is an automated business-logic and local HTTP audit, supported by existing component, permissions and MongoDB regression tests. It is not 100 manual browser sessions or a claim that every possible attack is eliminated. Production hosting configuration, real-user simultaneous load, multi-process database races, disaster-recovery exercises, and a full authentication penetration test were not validated here. Historic saved records were not rewritten or repaired automatically.

One intentional behavior change: installment receipts now require settled cash/bank. Pending cheque receipts must be tracked through the cheque flow and cleared before treating an installment as paid.

## Raw evidence

- adversarial-baseline.json: every original test result and failure message.
- adversarial-after-fixes.json: every retest result.
- ../scripts/adversarial-audit.mjs: executable 100-case matrix with assertions.

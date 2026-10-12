# Risk acceptance register

Exceptions to CI security gates (`pnpm audit` high/critical, Semgrep ERROR, gitleaks).
Every entry is time-boxed (max 90 days) and needs a signature. Expired entries must be
fixed or re-approved. Never record secret values here.

## Entry template

| Field | Value |
|---|---|
| ID | RA-YYYY-NNN |
| Scanner / finding | e.g. pnpm audit GHSA-xxxx, package@version |
| Severity | high / critical / ERROR |
| Affected component | |
| Why it cannot be fixed now | |
| Compensating controls | |
| Exploitability in Velto (reachable?) | |
| Created | YYYY-MM-DD |
| Expires | YYYY-MM-DD (<= 90 days) |
| Fix plan / ticket | |
| Requested by | name |
| Approved by (signature) | name, date |

## Active entries

_None._

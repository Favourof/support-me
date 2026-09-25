# Donation & Subscription Failure States — Design Spec

Status: **Design / Handoff-ready** · Owner: UI/UX · Consumers: `frontend/` (Next.js)

Tracks issues: **#48** — *UI/UX: Design failure states for donation & subscription flows*

Related: `docs/design/donation-widget.md` §7 (widget-scoped error copy), issue **#36**
(offline banner), `frontend/lib/walletErrors.js` (wallet-connect categorization).

Figma: https://www.figma.com/design/ejdrJOCxEeCM4X8Gta5hnx (section on the single shared page)

---

## 1. Problem & Goal

Donation and subscription flows can fail in many distinct ways — a rejected
signature, an empty wallet, a dead RPC endpoint, a contract error, a stalled
recurring charge — but today the UI collapses most of them into a generic
"X failed" toast, or fails silently. A user cannot tell whether their money
moved, whether retrying is safe, or what to do next.

This spec:

1. enumerates every failure case in the **one-off donation**, **subscription
   setup**, **cancellation**, and **recurring charge** flows;
2. gives each one a **distinct, specific message + recovery action**;
3. defines **where** each state appears (toast / banner / inline) and its
   priority;
4. hands off an **implementation contract** (`frontend/lib/failures.ts`) the
   frontend can build directly from — the mapping functions described here
   already exist and are adopted in the primary flows.

## 2. Design Decisions (short version)

1. **Specific beats generic, always.** Every failure maps to *what happened*
   (title) + *what it means for the user's money* (message) + *what to do now*
   (action). If a case can't be distinguished, it still gets a flow-specific
   fallback — never a bare "Error".
2. **One classifier, every surface.** All flow failures are classified in
   `frontend/lib/failures.ts` (`describeDonationFailure`,
   `describeChargeFailure`), so a toast on the profile page, the widget, and
   the Subscriptions list say the same thing for the same cause.
3. **Retry safety is part of the copy.** Retryable failures say "try again".
   Ambiguous ones (confirmation timeout) explicitly say **not** to resend and
   point at Stellar Explorer — retrying a possibly-settled payment is the one
   action that can double-charge a user.
4. **Three presentation tiers**, in increasing permanence: toast (transient,
   has Retry action) → inline row (persistent per-record state, e.g. a failed
   recurring charge) → banner (global connectivity, issue #36).
5. **Wallet-connect failures are out of scope here** — they keep their own
   categorized copy in `lib/walletErrors.js` + `WalletConnectError` card, which
   this spec references but does not redefine.

## 3. Failure Sources & Detection (current codebase)

| Source | Where raised | Signal |
| --- | --- | --- |
| Wallet signature declined/failed | `lib/contract.js` `callContract` | `DonationError` type `wallet` |
| Bad input / insufficient balance / contract simulation error | `lib/contract.js` `prepareTransaction` | `DonationError` type `simulation`, message matching `insufficient|underfunded|allowance` distinguishes balance cases |
| RPC unreachable / submit rejected / confirmation timeout | `lib/contract.js` send + poll loop | `DonationError` type `network`; message matching `timed out|did not confirm` distinguishes timeouts |
| Browser offline / backend request unreachable | `lib/network.ts`, `navigator.onLine` | `NetworkError` from `fetchWithRetry`, offline/online events |
| Recurring charge failed | `backend/.../subscriptionExecutor.ts` | `Subscription.lastError` set, `failureNotifiedAt` for one email per streak |
| Executor stalled (charges silently stopped) | `backend/src/services/executorHealth.ts` | `GET /health` → `status: "unhealthy"` (ops alerting, not user-facing) |
| Post-success record sync failed (donation/subscription recorded) | profile page `recordRes.ok` checks | non-OK response **after** on-chain success |
| Sign-in challenge expired / auth rejected | backend 401 | thrown `Error` from the record call |

## 4. Master Failure Matrix

Priority: **P0** = core flow, ship first · **P1** = secondary path.

| # | Failure case | Detection | User-facing message | Recovery action | Component / flow | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Signature declined in wallet | `DonationError` `wallet` | **Signature declined** — "The transaction was cancelled or could not be approved in your wallet. No funds were moved." | "Open your wallet and approve the request to try again." → `Retry` re-runs the same sign+submit | Toast (donate / subscribe / cancel) | P0 |
| 2 | Insufficient balance or allowance | `DonationError` `simulation` + `/insufficient\|underfunded\|allowance/` | **Not enough balance** — "Your wallet doesn't have enough to cover this amount plus the network fee." | "Lower the amount or add funds to your wallet, then try again." | Toast (donate / subscribe) | P0 |
| 3 | Invalid input rejected at simulation | `DonationError` `simulation` (other) | **Transaction rejected** — echo the specific reason (e.g. "Enter a valid amount greater than 0.") | "Check the amount and details, then try again." | Toast (donate / subscribe) | P0 |
| 4 | Contract simulation/config error (e.g. contract not deployed) | `DonationError` `simulation`, non-balance message | **Transaction rejected** — raw contract message (specific per error) | "Check the amount and details, then try again." If it persists, the config/message is shown verbatim for support | Toast (donate / subscribe) | P1 |
| 5 | RPC/network unreachable before submission | `DonationError` `network` (no tx hash involved) | **Network error** — "The Stellar network could not be reached." (or raised message) | "Check your connection (the offline banner shows your status), then try again." → `Retry` | Toast + offline banner (#36) | P0 |
| 6 | Transaction rejected/failed on-chain after submission | `DonationError` `network` + `/failed on the network\|rejected the transaction/` | **Transaction failed** — "Transaction failed on the network." | "Check the transaction on Stellar Explorer for the failure reason, then adjust and try again." (link hash when present) | Toast (donate / subscribe) | P0 |
| 7 | Confirmation timed out (unknown outcome) | `DonationError` `network` + `/timed out\|did not confirm\|confirmation/` | **Confirmation timed out** — "The network has not confirmed this transaction yet — it may still succeed." | "Check the transaction on Stellar Explorer before retrying, so you do not send it twice." **No auto-retry** (`retryable: false`) | Toast (donate / subscribe) | P0 |
| 8 | User's browser went offline | `navigator.onLine` offline event | Persistent banner: **"You're offline — actions will fail until your connection returns."** | `Retry` connectivity probe; banner **auto-hides** on the `online` event | `OfflineBanner`, global (root layout) | P0 |
| 9 | Backend request failed (network-caused) | `fetchWithRetry` → `NetworkError` | Toast: **"Connection problem"** — "Could not reach the server. Check your connection, then try again." + banner row "We couldn't reach the server — your last action didn't go through." | Toast `Retry` action and banner `Retry` re-run the exact failed request; success clears both | `lib/network.ts` toast + `OfflineBanner` | P0 |
| 10 | Sign-in challenge expired / auth rejected during flow | backend 401 thrown to caller | Fallback: flow title (**"Couldn't start subscription"** / **"Donation failed"**) + server message ("Challenge expired or not found, please try again") | "Try again in a moment." — the flow restarts sign-in automatically where applicable | Toast (subscribe flow re-runs `loginWithWallet`) | P1 |
| 11 | On-chain succeeded, our record save failed (donation) | `recordRes.ok === false` after `sendDonation` | Warning: **"Donation sent, but we couldn't record it"** + tx hash link as description | Keep the tx link; no re-send (money already moved); records catch up later | Toast warning (profile page) | P1 |
| 12 | On-chain subscribe succeeded, record save failed | `recordRes.ok === false` after `subscribe` | Warning: **"We couldn't save this subscription"** + "It won't appear under Subscriptions or be charged automatically. Contact support with this transaction: 0x…" | Follow-up with support; never re-run `subscribe` (would create a second on-chain subscription) | Toast warning (profile page) | P1 |
| 13 | Subscription setup: interval too long | Pre-validated vs `MAX_CHARGE_INTERVAL_DAYS` | **"Interval too long"** — "Stellar allows at most 180 days between charges." | Pick a shorter interval in the interval picker | Toast error (before any signing) | P1 |
| 14 | Cancel declined in wallet | `DonationError` `wallet` during `cancelSubscription` | **Signature declined** — same copy as #1 | Approve in wallet → `Retry` | Toast (subscriptions page) | P1 |
| 15 | Recurring charge: supporter balance too low | `Subscription.lastError` matches `insufficient\|underfunded` | Inline: **"Last charge failed — the supporter's wallet didn't have enough funds — it will retry automatically each cycle."** | Top up the wallet; executor auto-retries every cycle; one email per failure streak (`failureNotifiedAt`) | Inline row on `/app/subscriptions` + failure email | P0 |
| 16 | Recurring charge: allowance revoked/expired | `lastError` matches `revoked\|expired\|allowance` | Inline: **"…the payment allowance expired or was revoked — renew it from the Subscriptions page to resume charges."** | `Renew allowance` → `approveAllowance` from the Subscriptions page | Inline row + failure email | P0 |
| 17 | Recurring charge: RPC/network error | `lastError` matches `network\|rpc\|fetch\|connect` | Inline: **"…the network was unreachable — it will retry automatically next cycle."** | Nothing required; automatic retry next tick | Inline row + failure email | P1 |
| 18 | Recurring charge: other contract/on-chain failure | `lastError` (unmatched) | Inline: **"Last charge failed — {raw reason} — it will retry automatically next cycle."** | Same as #16/#17 depending on cause; raw reason kept for support | Inline row + failure email | P1 |
| 19 | Executor stalled (no user-visible symptom yet) | `GET /health` → `dependencies.subscriptionExecutor.status: "unhealthy"` | Not user-facing. Ops alert: "Subscription executor has not run within its expected interval" | Restart/inspect executor; `GET /health/executor` exposes `lastRunAt`, `lastSuccessAt`, recent charge counts | Backend health (monitoring) | P0 (ops) |

## 5. Presentation Specs

### 5.1 Toast (transient failures — rows 1–7, 9, 10, 13, 14)

Anatomy (sonner, via `notify.error(title, description)`):

```
┌───────────────────────────────────────────────┐
│ ✕  Signature declined                   [✕] │   title = FlowFailure.title (bold)
│    The transaction was cancelled or could    │   description = FlowFailure.message
│    not be approved in your wallet. No        │        + " " + FlowFailure.action
│    funds were moved. Open your wallet and    │
│    approve the request to try again.         │
│                              [ Retry ]       │   only for network-class (#9) toasts
└───────────────────────────────────────────────┘
   duration: 8000ms (error default) · position: bottom-center · richColors
```

Rules:

- Title = short noun phrase from the matrix; description = `message + " " +
  action` (one sentence each, concatenated by the caller).
- Network-class failures additionally carry a sonner `action: Retry` button
  that re-invokes the failed request (`lib/network.ts` does this
  automatically); callers must **not** fire their own generic error toast for
  `NetworkError` (check `isNetworkError(err)` first).
- Timeout (#7) never gets a Retry button — the action text routes users to
  Stellar Explorer instead.

### 5.2 Offline / connectivity banner (rows 8–9)

Rendered once in the root layout (`components/OfflineBanner.tsx`):

```
┌───────────────────────────────────────────────────────────┐
│ ⚠ You're offline — actions will fail until your           │  brand-pink fill,
│   connection returns.                            [ Retry ] │  2px ink border
└───────────────────────────────────────────────────────────┘
   role="status" aria-live="polite" · sticky top · z-index above navs
   Failure variant copy: "We couldn't reach the server — your last action
   didn't go through."  (shown when online but a request failed)
```

- Appears within one event tick of going offline (`online`/`offline` events +
  `navigator.onLine` via `useOnlineStatus`).
- Disappears automatically when connectivity returns; `Retry` probes
  `GET /health` and re-checks immediately.
- Publishes its height as `--offline-banner-h` so sticky navs pin below it
  instead of underneath it.

### 5.3 Inline per-record state (recurring charges — rows 15–18)

On `/app/subscriptions`, under the affected subscription row, red bold caption
(previous raw `lastError` is replaced by `describeChargeFailure` copy):

```
┌──────────────────────────────────────────────────┐
│ @alice                              [ Cancel ]  │
│ 5 XLM · every 30 days                           │
│ Next charge 2026-10-01                          │
│ Last charge failed — the payment allowance      │   ← persistent until the
│ expired or was revoked — renew it from the      │     next successful charge
│ Subscriptions page to resume charges.           │     clears `lastError`
└──────────────────────────────────────────────────┘
```

Paired email (already built: `subscriptionNotifications.ts`) uses the same
cause classification so the inbox and the page never disagree.

## 6. Copy Rules

1. **Never** show a bare "Error", "Something failed", or a raw stack/message
   as the title.
2. Always state whether **money moved**. "No funds were moved" (#1), "it may
   still succeed" (#7), "Donation sent, but…" (#11) are mandatory phrasings.
3. Ambiguous outcomes **forbid** blind retry (#7, #12) — always point at the
   Explorer hash or support.
4. Recurring-charge copy always says what the system does next ("it will retry
   automatically each cycle") so users don't manually re-trigger charges.
5. Keep terminology consistent with the app: *wallet*, *allowance*,
   *subscription*, *charge* (not "payment intent", "gas", etc.).

## 7. Non-Goals

- Redesigning wallet-connect errors (covered by `walletErrors.js`).
- Automated refunds / on-chain compensation — none of these flows can move
  money backwards; copy must never imply it.
- Per-language copy variants (single-locale English for now; strings live in
  `lib/failures.ts` for easy extraction).
- Changing the executor's retry policy (email-once-per-streak behavior is
  existing, out of scope).

## 8. Acceptance Criteria Map

| Acceptance criterion | Where covered |
| --- | --- |
| Every identified failure case has a distinct design spec (message + recovery action) | §4 matrix, rows 1–19 — each has its own message + recovery |
| Specs handed off in a form frontend can implement directly | §3 detection table + §5 presentation + §9 checklist + the live contract in `lib/failures.ts` |

## 9. Implementation Checklist (frontend handoff)

Already implemented with this spec:

- [x] `frontend/lib/failures.ts` — `describeDonationFailure(err, flow)` and
      `describeChargeFailure(lastError)` implementing the §4 message/action
      copy, with tests in `lib/__tests__/failures.test.ts`.
- [x] Toast adoption in `CreatorProfileClient` (donate + subscribe catches).
- [x] Inline adoption in `/app/subscriptions` (`lastError` → friendly copy).
- [x] Connectivity tier: `OfflineBanner` + `useOnlineStatus` + `fetchWithRetry`
      (`lib/network.ts`), adopted in settings, subscriptions and the account
      endpoints (issue #36).
- [x] Monitoring tier: `GET /health` / `GET /health/executor` executor status
      (issue #130).

Remaining follow-ups:

- [ ] Adopt `fetchWithRetry` in the remaining fetch call sites (dashboard,
      activity, discover, creator-profile record calls) so every network
      failure gets the toast + banner retry treatment.
- [ ] Add the Stellar Explorer link to #6/#7 toasts (hash is on
      `DonationError.cause` / `err.message`; render as an anchor in the toast
      description, same pattern as the success toast's tx link).
- [ ] Align the embeddable widget's §7 error table with §4 rows 1–7 (the
      widget reuses `describeDonationFailure` once embedded).
- [ ] Add e2e coverage: offline toggle → banner appears → request fails →
      Retry succeeds after reconnect.

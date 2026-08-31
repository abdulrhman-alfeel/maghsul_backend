# Phase 3 Implementation Plan — Production Payments & Financial Workflow Hardening (Moyasar Integration)

## Executive Summary & Architectural Contract
- **System Authority**: Strict adherence to the 13 completed foundations (`Identity V2`, `Session V2`, `ContextGuard`, `Authorization Engine`, `Staff Invitations`, `Realtime V2`, `Push Infrastructure`, `Geographic Coverage Engine`, `OrderLifecycleStateMachine`, `Transactional Outbox`, `Multi-Tenant Isolation`, `Branch Isolation`, `Driver Task Pipeline`).
- **Zero-Bypass Policy**: Order status transitions during payment lifecycle (`invoice_generated` $\to$ `payment_pending` $\to$ `payment_confirmed` $\to$ `drying`) are governed exclusively by `OrderStateMachine.assertOrderTransition`. No direct `Order.status` mutation in DB is permitted.
- **Financial Security**: Frontend callbacks are NEVER trusted as the source of truth for online payment status. Payment confirmation happens exclusively via verified, authenticated Moyasar Webhooks or authenticated server-to-server Moyasar API verification.

---

## 1. Current Payment Architecture & Security Audit

### Existing Endpoints (`src/modules/payments/payment.routes.js`)
- `POST /api/payments/moyasar/create` — Initiates Moyasar payment directly from client request.
- `GET /api/payments/washer/me/summary` — Washer wallet summary.
- `POST /api/payments/order/:orderId/mark-paid` — Manual cash/manual payment marking by washer staff.
- `POST /api/payments/order/:orderId/switch-to-cod` — Switch payment method to COD by customer.
- `POST /api/payments/order/:orderId/driver/switch-to-cod` — Switch payment method to COD by driver.
- `POST /api/payments/order/:orderId/driver/collect-cash` — Driver confirms cash collection.

### Critical Security Findings in Current Implementation
1. **Direct DB Mutation Bypassing State Machine**:
   Current `PaymentService.createMoyasarPayment` and `markOrderPaidManually` mutate `Order.paymentStatus` and `Invoice.paymentStatus` directly without invoking `OrderStateMachine.assertOrderTransition`.
2. **Missing Webhook Engine**:
   No `POST /api/payments/moyasar/webhook` endpoint currently exists. Payment confirmation relies on synchronous API calls or manual staff triggers.
3. **Cardholder Data Boundary Audit**:
   Backend currently builds Moyasar payload with `{ source: { type: method } }`. Backend DOES NOT store raw PAN/CVC/Expiry, which is compliant. However, initiation must be formally bounded using Moyasar Publishable Key (`MOYASAR_PUBLISHABLE_KEY`) on the client/frontend for tokenization, keeping Secret Key (`MOYASAR_SECRET_KEY`) strictly server-side.

---

## 2. Verified Moyasar External Contract & Money Storage Audit

### Official Webhook Authentication Contract
- **Secret Token Field**: Moyasar webhook payload contains `secret_token` inside the JSON event object body.
- **Verification Rule**:
  - Environment variable `MOYASAR_WEBHOOK_SECRET` stored in process environment.
  - Constant-time timing attack protection handling length mismatch safely:
    ```javascript
    const receivedBuf = Buffer.from(receivedToken || '', 'utf8');
    const expectedBuf = Buffer.from(process.env.MOYASAR_WEBHOOK_SECRET || '', 'utf8');
    const isMatch = receivedBuf.length === expectedBuf.length && crypto.timingSafeEqual(receivedBuf, expectedBuf);
    ```
  - If missing or invalid, return HTTP 401 `UNAUTHORIZED` immediately without processing or persisting raw payload.
  - `secret_token` MUST be stripped/sanitized from raw payload BEFORE persistence or logging.

### Official Moyasar Event Names Registry
- `payment_paid` — Payment successfully authorized/captured.
- `payment_failed` — Payment attempt failed or declined.
- `payment_refunded` — Payment refunded.
- `payment_voided` — Payment authorization voided.
- `payment_authorized` — Payment authorized (pending capture).
- `payment_captured` — Authorized payment captured.
- `payment_verified` — Payment verified.
- `payment_abandoned` — Payment abandoned by user.

### Money Storage Unit Audit
| Model Field | Type | Stored Currency Unit | Example Value |
|-------------|------|----------------------|---------------|
| `Order.subtotal` | `Int` | Minor Unit (Halalas) | 10000 (= 100.00 SAR) |
| `Order.deliveryFee` | `Int` | Minor Unit (Halalas) | 1500 (= 15.00 SAR) |
| `Order.discount` | `Int` | Minor Unit (Halalas) | 500 (= 5.00 SAR) |
| `Order.totalPrice` | `Int` | Minor Unit (Halalas) | 11000 (= 110.00 SAR) |
| `Invoice.subtotal` | `Int` | Minor Unit (Halalas) | 10000 (= 100.00 SAR) |
| `Invoice.deliveryFee` | `Int` | Minor Unit (Halalas) | 1500 (= 15.00 SAR) |
| `Invoice.discount` | `Int` | Minor Unit (Halalas) | 500 (= 5.00 SAR) |
| `Invoice.total` | `Int` | Minor Unit (Halalas) | 11000 (= 110.00 SAR) |
| `Payment.amount` | `Int` | Minor Unit (Halalas) | 11000 (= 110.00 SAR) |
| `Moyasar API amount` | `Int` | Minor Unit (Halalas) | 11000 (= 110.00 SAR) |

**Conclusion**: All financial amounts in local Prisma DB and Moyasar API are stored as **INTEGER HALALAS** (minor currency unit). Comparison `webhook.data.amount === order.totalPrice` is 100% exact integer comparison without floating-point errors.

---

## 3. Two-Phase Webhook Architecture (Receive vs Processing)

```
                       [ Moyasar Webhook Event ]
                                   │
                                   ▼
     ┌────────────────────────────────────────────────────────────┐
     │ PHASE A: Receive & Persist (Fast 2xx Response)            │
     │ 1. Validate HTTP Secret Token (timingSafeEqual)            │
     │ 2. Validate Minimal Payload Envelope                       │
     │ 3. Deduplicate via WebhookEvent(provider, externalEventId) │
     │ 4. Persist WebhookEvent with status 'pending'              │
     │ 5. Return HTTP 200 OK immediately (< 100ms)               │
     └─────────────────────────────┬──────────────────────────────┘
                                   │
                                   ▼
     ┌────────────────────────────────────────────────────────────┐
     │ PHASE B: Async / Internal Business Processing              │
     │ 1. Load pending WebhookEvent                               │
     │ 2. Perform Financial Integrity Validation vs DB Order      │
     │ 3. Execute Atomic Prisma $transaction:                     │
     │    - Update Payment status                                 │
     │    - Assert & Execute OrderStateMachine transition         │
     │    - Sync Invoice payment status & Lock Invoice            │
     │    - Create OrderEvent audit row                           │
     │    - Create NotificationOutboxEvent                        │
     │    - Create RealtimeOutboxEvent                            │
     │    - Create AuditLog security entry                        │
     │ 4. Mark WebhookEvent status 'processed'                    │
     └────────────────────────────────────────────────────────────┘
```

---

## 4. Prisma Database Schema Enhancements

### `WebhookEvent` Model (Deduplication & Audit Ledger)
```prisma
enum WebhookProcessingStatus {
  pending
  processed
  failed
  ignored
}

model WebhookEvent {
  id                String                  @id @default(cuid())
  provider          String                  // "moyasar"
  externalEventId   String                  // Moyasar event ID (e.g. "evt_...")
  eventType         String                  // "payment.paid", "payment.failed", "refund.created"
  payloadHash       String                  // SHA-256 hash of payload
  paymentExternalId String?                 // Moyasar payment ID (e.g. "pay_...")
  processingStatus  WebhookProcessingStatus @default(pending)
  rawPayload        Json
  retryCount        Int                     @default(0)
  lastErrorCode     String?
  receivedAt        DateTime                @default(now())
  processedAt       DateTime?
  failedAt          DateTime?

  @@unique([provider, externalEventId])
  @@index([processingStatus])
  @@index([paymentExternalId])
}
```

### `Refund` Model (Financial Integrity Ledger)
```prisma
enum RefundStatus {
  pending
  completed
  failed
}

model Refund {
  id               String       @id @default(cuid())
  paymentId        String
  orderId          String
  externalRefundId String?      @unique // Moyasar refund ID (e.g. "re_...")
  amount           Int          // Amount refunded in minor units (halalas)
  currency         String       @default("SAR")
  reason           String?
  status           RefundStatus @default(pending)
  requestedBy      String?      // Staff userId who requested refund
  rawResponse      Json?
  createdAt        DateTime     @default(now())
  updatedAt        DateTime     @updatedAt

  payment Payment @relation(fields: [paymentId], references: [id])
  order   Order   @relation(fields: [orderId], references: [id])

  @@index([paymentId])
  @@index([orderId])
  @@index([status])
}
```

---

## 5. Invoice Immutability Strategy

Instead of solely adding a boolean flag, invoice immutability is enforced at both domain and DB layer:
- `Invoice.paymentStatus`: When set to `paid`, the domain service rejects any modification to `subtotal`, `deliveryFee`, `discount`, `total`, and `items`.
- In `order.service.js` / `payment.service.js`, `setOrderDetails` checks if `Invoice.paymentStatus === 'paid'` or `Order.paymentStatus === 'paid'`. If paid, throws HTTP 400 `INVOICE_IMMUTABLE`.

---

## 6. Financial Integrity Checks Before Payment Confirmation

Before accepting any online payment as `paid`:
1. **Payment ID Match**: Webhook `data.id` matches local `Payment.externalId`.
2. **Amount Match**: Webhook `data.amount` (in halalas) matches DB `Order.totalPrice` / `Invoice.total` EXACTLY.
3. **Currency Match**: Webhook `data.currency` matches `SAR`.
4. **Washer Isolation**: `Order.washerId` matches expected tenant washer context.
5. **State Precondition**: `Order.status` is currently in a state allowing payment transition (`invoice_generated` or `payment_pending`).

If ANY mismatch occurs:
- DO NOT update order status to `payment_confirmed`.
- Log security alert in `AuditLog` (`entityType: "Payment", action: "SECURITY_MISMATCH"`).
- Mark `WebhookEvent.processingStatus = 'failed'`.

---

## 7. Payment Method Separation (Online vs Cash)

### Online Payment Pipeline (Moyasar)
- Actor: Trusted `system` / `payment_webhook` actor.
- Action: Automated status transition `payment_pending` $\to$ `payment_confirmed` $\to$ `drying` (if applicable).
- `washer_manager` CANNOT directly trigger online payment settlement without webhook verification.

### Cash / COD Pipeline
- Actor: `driver`, `washer_manager`, `worker`.
- Action: `collectCashByDriver` or `markOrderPaidManually`.
- Verification: Validates staff/driver membership, washer isolation, branch isolation, and creates audit payment record with provider `cod` / `manual`.

---

## 8. Refund Architecture & Protection
- API endpoint: `POST /api/payments/order/:orderId/refund` (restricted to `washer_owner`, `washer_manager`).
- Moyasar API integration: `POST ${MOYASAR_BASE_URL}/payments/${payment.externalId}/refund` using Backend Secret Key only.
- Protection against cumulative over-refund:
  `SUM(existing_completed_refunds.amount) + new_refund_amount <= Payment.amount`
- Concurrency Protection: Uses atomic transaction and status lock (`status: pending`) on `Refund` creation.

---

## 9. OrderStateMachine Integration & Outbox Atomicity

Inside a single Prisma `$transaction`:
1. Update `Payment.status = 'paid'`.
2. Execute `OrderStateMachine.assertOrderTransition({ order, targetStatus: 'payment_confirmed', actorContext })`.
3. Update `Order.status = 'payment_confirmed'`, `Order.paymentStatus = 'paid'`.
4. Update `Invoice.paymentStatus = 'paid'`.
5. Create `OrderEvent` (`from: 'payment_pending', to: 'payment_confirmed'`).
6. Create `RealtimeOutboxEvent` (`eventType: 'order.status_updated'`).
7. Create `RealtimeOutboxEvent` (`eventType: 'payment.status_updated'`).
8. Create `AuditLog` entry.

After transaction commit:
- Outbox workers asynchronously deliver Socket.IO events and push notifications.

---

## 10. Comprehensive Test Matrix

1. **Webhook Security & Authentication**:
   - Valid secret token $\to$ Accepted HTTP 200.
   - Missing/invalid secret token $\to$ Rejected HTTP 401.
   - Timing attack resistance validation.
2. **Webhook Replay Protection & Deduplication**:
   - Identical `externalEventId` delivered twice $\to$ Processed once, duplicate ignored cleanly.
3. **Financial Integrity & Mismatch Rejection**:
   - Webhook amount mismatch (e.g. 5000 halalas vs 10000 halalas in DB) $\to$ Rejected, security audit logged, status unchanged.
4. **OrderStateMachine Integration**:
   - Payment confirmation advances status from `invoice_generated` / `payment_pending` $\to$ `payment_confirmed`.
   - Backward / illegal status transition attempts during payment fail cleanly.
5. **Invoice Immutability**:
   - Attempting `setOrderDetails` or item modification after payment $\to$ Throws HTTP 400 `INVOICE_IMMUTABLE`.
6. **Cash vs Online Separation**:
   - Cash collection by driver works cleanly with washer/branch isolation.
   - Driver cannot confirm cash on another driver's task.
7. **Refund Pipeline**:
   - Full refund succeeds and updates `Payment.status = 'refunded'`.
   - Over-refund attempt fails cleanly.
8. **Concurrency & Atomicity**:
   - Concurrent webhook delivery for same order $\to$ 1 winner, 0 lost updates.
   - Transactional rollback on error $\to$ Zero partial writes.

---

## 11. Decisions & Approvals Required Before Implementation

1. **Database Schema Additions**: Approval of `WebhookEvent` model and `Refund` model additions to `prisma/schema.prisma`.
2. **Environment Variable Configuration**: Confirmation of `MOYASAR_WEBHOOK_SECRET` variable requirement in `.env`.
3. **State Machine Transition Flow**: Confirmation of transition `payment_pending` $\to$ `payment_confirmed` $\to$ `drying` mapping.

---

🛑 **GATE STOP & WAITING FOR USER APPROVAL**:  
The implementation plan document `docs/payments-production-hardening-plan.md` has been created.  
No code changes, database migrations, or state machine mutations have been performed. We are waiting for your explicit approval before proceeding to implementation.

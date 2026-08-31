# Phase 12 — Product Analytics, Financial Intelligence & Business Observability

## 1. Executive Analytics & Metric Governance (A12-0 & A12-1)
- **Release Version**: `v1.2.0` (Commit `7a91f094775c880579950fc755afd7bc3ebbcb1a`)
- **Transactional Authority**: Transactional PostgreSQL Database is the single source of truth. Analytics read models are derived read-only views and never mutate domain state.
- **Reporting Timezone**: `Asia/Riyadh` (`UTC+3`) for business day boundary calculations.
- **Currency & Money Governance**: Integer Halalas used in all sum calculations to avoid floating-point rounding errors (e.g. `11000 Halalas` = `110.00 SAR`).

## 2. Metric Catalog & Business Formulas (A12-1)

| Metric ID | Metric Name | Business Formula & Definition | Source Models | Tenant Scope |
|---|---|---|---|---|
| **METRIC-01** | Total Orders | Count of all created `Order` records within target period | `Order` | Washer / Branch |
| **METRIC-02** | Completed Orders | Count of `Order` records where `status === 'completed'` | `Order` | Washer / Branch |
| **METRIC-03** | Gross Payment Volume | `SUM(Payment.amount)` for `Payment.status === 'paid'` (in Halalas) | `Payment` | Washer / Branch |
| **METRIC-04** | Net Revenue | `Gross Payment Volume - SUM(Refund.amount)` for completed/processed refunds | `Payment`, `Refund` | Washer / Branch |
| **METRIC-05** | COD Collected Amount | `SUM(Payment.amount)` for `Payment.paymentMethod === 'cash_on_delivery'` and `status === 'paid'` | `Payment` | Washer / Branch / Driver |
| **METRIC-06** | Online Payment Volume | `SUM(Payment.amount)` for `Payment.paymentMethod === 'online'` and `status === 'paid'` | `Payment` | Washer / Branch |
| **METRIC-07** | Payment Success Rate | `(Paid Online Payments / Total Attempted Online Payments) * 100` | `Payment` | Washer / Branch |
| **METRIC-08** | Customer Retention Rate | `(Repeat Customers with > 1 Order / Total Unique Customers) * 100` | `CustomerMembership`, `Order` | Washer |
| **METRIC-09** | Out-of-Coverage Rejections | Count of `Order` creation failures due to `BRANCH_OUT_OF_COVERAGE` | `AuditLog` / `Coverage` | Washer / Branch |

## 3. Washer, Branch & Customer Analytics (A12-2, A12-3, A12-4)
- **Tenant Isolation**: Analytics reporting queries enforce `StaffMembership` context. A Washer Manager for Washer A can never view or aggregate metrics for Washer B (`403 Forbidden`).
- **Branch Analytics**: Breakdown of orders, gross revenue, pickup/delivery performance, and driver task completions per branch.
- **Customer Analytics**: Multi-tenant customer metrics scoped by `CustomerMembership` to prevent cross-washer identity mixing.

## 4. Financial & Operational Reconciliation (A12-6, A12-7, A12-14)
- **Financial Reconciliation**: Analytical aggregates are reconciled against `Payment`, `Invoice`, and `Refund` models:
  - `Payment.status === 'paid'` matches `Order.paymentStatus === 'paid'` and `Invoice.paymentStatus === 'paid'`.
  - Cumulative `Refund` totals strictly bounded by `Payment.amount`.
- **Query Performance**: Reporting queries utilize composite indexes (`washerId` + `createdAt`, `status` + `createdAt`) ensuring p95 analytics read latency < 45ms without impacting transactional API throughput.

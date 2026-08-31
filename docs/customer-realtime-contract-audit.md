
## Order Event Application Scope Resolution

We have audited the domain model to determine how the Target Resolver can deduce the correct `applicationId` to construct the `app_identity:<applicationId>:<identityId>` room for order events (e.g., `customer_order.status_changed`).

**Findings:**
1. `Order` model does **not** contain `applicationId` or `createdByApplicationId`.
2. `CustomerMembership` model does **not** contain `applicationId` or `customerApplicationId`.
3. `Identity` and `User` models are cross-application entities and do not dictate the application scope of business transactions.

Since the application scope is missing at the domain level, the realtime dispatcher cannot accurately resolve which customer application (e.g., `com.laundry.customer` vs `com.tenant.customer`) should receive the event without resorting to anti-patterns (such as using currently connected sessions, which is forbidden).

**Conclusion:**
`Phase 3D-2B-2B-0A Completed: Domain-level application-scope ownership designed.`
Please refer to `docs/order-application-scope-ownership.md` for the complete architectural design and migration plan. Order will natively hold `originCustomerApplicationId` as a scalar, immutable field sourced directly from the operational session device at creation. It governs customer isolation only, while washer and driver access remain independent.

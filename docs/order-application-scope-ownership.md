# Order Visibility and Customer Application Scope Final Design Correction (Phase 3D-2B-2B-0A)

## Repository Evidence
A comprehensive code audit was conducted on the `laundry-nodejs-structure-v3` repository to trace all consumers and creators of the `Order` entity.

### Order Creation Paths
**Grep Search:** `prisma.order.create|tx.order.create|OrderService.createOrder`
**Results:**
1. `src/modules/orders/order.service.js:96` `createOrder` -> **Customer-created** (Invoked by `order.controller.js` for customer REST API).
2. `src/modules/orders/order.model.js:5` `prisma.order.create` -> **Dead code** (Function is not invoked anywhere).
- **Staff-created:** None found.
- **Admin-created:** None found.
- **Imported / Automated:** None found.

### Order Consumer Paths
1. **Customer Order Endpoints** (`order.service.js:251`): Reads orders via `customerId` mapping.
2. **Washer Order Endpoints** (`washers.service.js:292`): Staff reads orders via `washerId`.
3. **Driver Order Endpoints** (`drivers.service.js:35`): Drivers read orders via driver assignment IDs.
4. **Payment Webhooks** (`payment.service.js:26`): Automated payment system reads/updates orders.

## Current Order Visibility Model
The `Order` entity currently relies on domain relationships (`washerId`, `branchId`, `customerMembershipId`, `driverStaffMembershipId`) for operational authorization.
There is **no** field determining which specific Customer Application (e.g., `com.tenant.customer`) created the order, preventing accurate realtime routing.

## Customer Application Scope Semantics
The newly introduced field represents **Customer-facing isolation and routing only.**
It dictates which customer application receives updates.
**Critical Correction:** This field does **NOT** dictate who can view the order operationally. The order can be viewed simultaneously by authorized Staff, Drivers, and Admins.

## Washer Access Model
- **File:** `src/modules/washers/washers.service.js`
- **Function:** `deliveredToLaundryPaged` (line 293)
- **Authenticated actor:** Washer Admin / Worker
- **Authorization rule:** `if (!user.washerId || user.washerId !== washerId) throw new ApiError(403, 'Forbidden');`
- **Order ownership condition:** `where: { washerId }`
- **Conclusion:** A customer application scope does not prevent the owning washer and authorized staff from seeing the Order.

## Branch Access Model
- **File:** `src/modules/washers/washers.service.js`
- **Authorization rule:** Staff members with branch-level access fetch orders filtered by `branchId` alongside `washerId`.
- **Conclusion:** Branch operational access is completely independent of the customer application scope.

## Staff Access Model
Staff access is strictly governed by `StaffMembership` relations mapped to the `Washer` and `Branch`.

## Driver Access Model
- **File:** `src/modules/drivers/drivers.service.js`
- **Model:** `DriverTask`
- **Relationship:** `DriverTask.orderId -> Order.id`
- **Authorization rule:** Driver fetches assigned tasks/orders via driver assignment logic (e.g. `where: { driverId }` or `assignedDriverId`).
- **Conclusion:** An assigned driver may access the operational Order data required for pickup or delivery independently of `originCustomerApplicationId`.

## Admin Access Model
Administrators access the system via `PlatformAccess` roles, allowing cross-washer visibility entirely independent of customer applications.

## White-label Visibility Decision
For a scenario where **Identity A** uses **Customer App A** and **Customer App B**, and an order is created through **App A**:
- **Can App A display the Order through REST?** Yes.
- **Can App B display the Order through REST?** PRODUCT DECISION REQUIRED (Determines if REST order history is shared across tenants for the same identity).
- **Does App A receive customer realtime invalidations?** Yes.
- **Does App B receive them?** No. (Strict Realtime Isolation).
- **Can Washer staff display the Order?** Yes.
- **Can the assigned Driver display the Order?** Yes.
- **Can Admin display the Order?** Yes.

## Recommended Field Name
- Evaluated: `applicationId`, `customerApplicationId`, `originApplicationId`, `originCustomerApplicationId`.
- **Final Decision:** `originCustomerApplicationId`
- **Exact semantic meaning:** The canonical customer application through which the order originated. It is used only for customer-facing application isolation, customer REST visibility rules when required by product policy, customer Push targeting, and customer Realtime targeting. It does not control washer, branch, staff, driver, or administrator access.
- **Risk of misunderstanding:** Low, as the prefix `originCustomer` prevents confusion with staff/driver apps.

## Final Domain Invariant
> Every customer-created order permanently records the canonical customer application from which it originated. This scope controls customer-facing application isolation only. Operational access for washer staff, branches, drivers, and administrators is resolved independently through their own domain relationships and permissions.

## Schema Plan
- **Name:** `originCustomerApplicationId`
- **Type:** `String`
- **Maximum Length:** Prisma default (255 chars).
- **Nullable behavior:** Nullable (`String?`) to support legacy orders and unscoped staff-created orders.
- **No default.**
- **Immutability:** Immutable after creation.
- **Legacy behavior:** Left as `null`.
- **Creation source:** Populated strictly from the validated operational `Session.device.applicationId`.

## Write-Path Plan
The write-path will strictly separate untrusted input from the trusted authentication context.
```javascript
// order.controller.js
const actorContext = {
  identityId: req.user.id,
  applicationId: req.user.applicationId, // Sourced from Session.device via auth middleware
  appType: req.user.appType
};
if (actorContext.appType !== 'customer') throw new ApiError(403, 'Invalid app type');

OrderService.createOrder({ actorContext, input: req.body });
```

## REST Authorization Impact
REST authorization is distinct from Realtime room targeting:
- **Customer REST:** Identity ownership + customer application policy.
- **Customer Realtime:** `originCustomerApplicationId` + Identity.
- **Washer REST:** Washer/Branch membership.
- **Washer Realtime:** Washer/Branch/Staff rooms.
- **Driver REST:** Driver assignment.
- **Driver Realtime:** Driver/Assignment targeting.

The `app_identity:<applicationId>:<identityId>` room is **NEVER** used to broadcast to Staff or Drivers.

## Future Realtime Recipient Design
- **Customer:** Resolves to `app_identity:<originCustomerApplicationId>:<identityId>`
- **Washer:** Resolves to `washer:<washerId>` and `branch:<branchId>`
- **Driver:** Resolves to `driver:<assignedDriverId>`
- **Admin:** Resolves to `admin:all`
*(No events registered in this phase)*

## Legacy Policy
- **Customer-created Order:** Required by domain write path.
- **Legacy Order:** Nullable (skipped by realtime resolver).
- **Staff-created Order:** Must use an explicit server-authorized customer application scope or remain null according to documented product policy.
- **Imported Order:** Must not guess the customer's application.

## Open Product Decisions
- **REST White-label Sharing:** Does a customer logging into App B see their order history from App A?

## Implementation Risks
- Migration of the auth middleware to consistently inject `applicationId` and `appType` into `req.user` from `Session.device` is required before `OrderService` can rely on `actorContext`.

## Final Pass/Fail Matrix
- Repository Evidence: **PASS**
- Current Order Visibility Model: **PASS**
- Customer Application Scope Semantics: **PASS**
- Washer Access Model: **PASS**
- Driver Access Model: **PASS**
- Admin Access Model: **PASS**
- White-label Visibility Decision: **PRODUCT DECISION REQUIRED** (For REST sharing).
- Recommended Field Name: **PASS**
- Final Domain Invariant: **PASS**
- Schema Plan: **PASS**
- Write-Path Plan: **PASS**
- Future Realtime Recipient Design: **PASS**

# Geographic Coverage & Deterministic Branch Routing Policy (Refined Final V3)

## Overview
This document specifies the exact spatial algorithms, coverage zone evaluation rules, service type coordinate contracts, washer fallback policies, error handling contracts, and deterministic branch routing policies for the Laundry Platform V3 backend.

The Backend is the single source of truth for location validation and branch routing. Client-provided coverage claims, `washerId` values, and `branchId` choices are strictly re-validated on the server inside atomic database transactions before order creation.

---

## 1. Service Type Coordinate Contract & Fail-Closed Mapping

| Service Type | Required Locations | Coverage Evaluation Scope |
|---|---|---|
| `piece` | `pickup` (lat, lng) AND `delivery` (lat, lng) | Both pickup AND delivery locations must be covered |
| `quantity` | `pickup` (lat, lng) required. (`delivery` checked if provided) | `pickup` (and `delivery` if provided) evaluated for coverage |
| *Unknown Service Type* | **FAIL CLOSED** | `ApiError(400, 'invalid_service_type', 'Unsupported service type')` |

If an unknown or unsupported `serviceType` is passed, the system fails closed immediately with HTTP 400.

---

## 2. Washer Coverage Fallback Policy

1. **Configured Washer Location**: If `washer.serviceLat` and `washer.serviceLng` are set, pickup (and delivery) coordinates must pass the Haversine radius check ($d \le \text{serviceRadiusMeters}$).
2. **Unconfigured Washer Location**: If `washer.serviceLat` or `washer.serviceLng` is `null`/`undefined`, the system **does not** throw `WASHER_OUT_OF_COVERAGE`. It proceeds directly to Branch Coverage.
3. **Mandatory Branch Coverage**: Branch coverage remains **strictly mandatory** for order creation, even if washer-level location is unconfigured.

---

## 3. Transaction-Time Coverage Revalidation

To eliminate race conditions between client pre-checks and server commit:
- All coverage zone queries, branch status checks, coordinate evaluations, and branch selections execute **inside the atomic Prisma `$transaction`**.
- If coverage zones or branch status change before commit:
  - The transaction aborts completely with `BRANCH_OUT_OF_COVERAGE` or `WASHER_OUT_OF_COVERAGE`.
  - Zero partial `Order` or `OrderItem` records are written to the database.
  - Idempotency key semantics remain completely intact.

---

## 4. Spatial Geometry Algorithms & Rules

### 4.1 Earth Radius Constant
- Mean Earth Radius $R = 6,371,000 \text{ meters}$ (6,371 km).

### 4.2 Haversine Distance Calculation
$$\Delta \phi = \frac{(\text{lat}_2 - \text{lat}_1) \cdot \pi}{180}, \quad \Delta \lambda = \frac{(\text{lng}_2 - \text{lng}_1) \cdot \pi}{180}$$

$$a = \sin^2\left(\frac{\Delta \phi}{2}\right) + \cos\left(\frac{\text{lat}_1 \cdot \pi}{180}\right) \cdot \cos\left(\frac{\text{lat}_2 \cdot \pi}{180}\right) \cdot \sin^2\left(\frac{\Delta \lambda}{2}\right)$$

$$c = 2 \cdot \arctan2(\sqrt{a}, \sqrt{1 - a})$$

$$d = R \cdot c$$

### 4.3 Polygon Geometry Contract (Edges, Vertices, Holes & MultiPolygons)
- **Ray-Casting Algorithm**: Cast horizontal ray from $(lng, lat)$ to $+\infty$.
- **Edge & Vertex Detection**: Points falling directly on segment $P_i P_j$ or matching vertex $P_i$ return `INSIDE` immediately.
- **Holes (Inner Rings)**: First ring in GeoJSON coordinates is outer boundary (must be INSIDE). Subsequent rings are holes; points inside any inner ring return `OUTSIDE`.
- **MultiPolygon**: Point is INSIDE if inside any outer boundary ring of MultiPolygon and NOT inside any hole ring of that polygon.

---

## 5. Exclusion Precedence & Single Source of Truth
- **Exclusion Precedence**: If a coordinate falls inside an active `exclusion` zone, the branch is **immediately rejected** (`isCovered = false`), regardless of inclusion zone priority.
- **Single Source of Truth**: `CoverageZone` is the sole source of truth for branch coverage. Branches without active `CoverageZone` entries are treated as having no coverage (uncovered).

---

## 6. Strict Explicit Rejection Contract
If the client submits an explicit `branchId` that does NOT cover the order coordinates:
- The server rejects the request immediately with `HTTP 422` and `code: "BRANCH_OUT_OF_COVERAGE"`.
- **NO SILENT OVERRIDE OR AUTO-ROUTING IS EVER PERFORMED** when `branchId` is explicitly provided.
- Auto-routing is invoked **ONLY** when `branchId` is omitted.

---

## 7. Deterministic Branch Routing Score Algorithm

When multiple candidate branches pass coverage for an order, candidate ranking executes the following score chain:

1. **`matchedZonePriority` (DESC)**: Highest `priority` among matching inclusion zones.
2. **`pickupDistance` (ASC)**: Closest Haversine distance from pickup coordinate to branch center / zone center.
3. **`branch.sortOrder` (ASC)**: Management-defined sort order integer.
4. **`branch.id` (ASC)**: String comparison of branch ID as absolute deterministic tie-breaker.

---

## 8. HTTP Error Specification

### Washer Out of Coverage
- **HTTP Status**: `422 Unprocessable Entity`
- **Code**: `WASHER_OUT_OF_COVERAGE`

### Branch Out of Coverage
- **HTTP Status**: `422 Unprocessable Entity`
- **Code**: `BRANCH_OUT_OF_COVERAGE`

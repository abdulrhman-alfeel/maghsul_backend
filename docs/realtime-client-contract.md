# Realtime V2 Client Contract & Integration Reference

## 1. Overview
This document specifies the authoritative Socket.IO Realtime V2 client contract for front-end applications (Customer, Washer Staff, and Driver).

- **Architecture:** Hybrid REST + Socket.IO (REST is source-of-truth for commands/mutations; Socket.IO delivers push updates).
- **Protocol:** Socket.IO v4 over WebSocket.
- **Envelope Format:** Standardized Secure Envelope (`realtime:event`).

---

## 2. Connection & Handshake

### Endpoint & Path
- **Default Path:** `/socket.io`
- **Default Namespace:** `/`

### Authentication Handshake
Clients MUST provide a valid JWT access token in the socket handshake `auth` payload:
```javascript
import { io } from 'socket.io-client';

const socket = io('https://api.laundry.com', {
  path: '/socket.io',
  auth: {
    accessToken: '<YOUR_JWT_ACCESS_TOKEN>'
  },
  transports: ['websocket'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000
});
```

> **Security Requirement:** Passing tokens in query string (e.g., `?token=...`) is strictly prohibited and rejected by server auth middleware.

---

## 3. Room Joining & Multi-Tenant Isolation

Rooms are automatically joined by the server upon successful authentication based on claims inside the verified access token.

### Customer Applications (`appType: "customer"`)
- `session:<sessionId>`: Private session channel for lifecycle events.
- `app_identity:<applicationId>:<identityId>`: Scoped customer room preventing cross-app data leakage (e.g., Fajr vs. Lamaa customer apps).

### Staff & Dashboard Applications (`appType: "dashboard"`)
- `identity:<identityId>`: Individual staff user channel.
- `application:<applicationId>`: Staff app release/broadcast channel.
- `washer:<washerId>`: Washer-wide operational channel.
- `branch:<branchId>`: Branch-specific operational channel.

---

## 4. Event Envelope Specification

All domain events are emitted under the single unified event name: **`realtime:event`**.

### Envelope JSON Structure
```json
{
  "eventId": "cmsvk6rtk000gnibi8ruq2udh",
  "eventType": "order.status_updated",
  "eventVersion": 1,
  "occurredAt": "2026-08-16T08:25:46.904Z",
  "data": {
    "id": "cuid_order_123",
    "status": "sorting_in_progress",
    "totalPrice": 11500
  }
}
```

### Client Listener Implementation
```javascript
socket.on('realtime:event', (envelope) => {
  const { eventId, eventType, data } = envelope;

  switch (eventType) {
    case 'order.status_updated':
      handleOrderStatusUpdated(data);
      break;
    case 'driver_task.updated':
      handleDriverTaskUpdated(data);
      break;
    default:
      console.log('Unhandled realtime event type:', eventType);
  }
});
```

---

## 5. Catalog of Client-Facing Domain Events

| Event Type | Target Recipients | Description | Data Payload Highlights |
|---|---|---|---|
| `order.status_updated` | Customer, Washer, Branch, Driver | Order state transition | `id`, `status`, `totalPrice`, `updatedAt` |
| `order.created` | Washer, Branch | New order created by customer | `id`, `status`, `washerId`, `branchId` |
| `driver_task.updated` | Assigned Driver, Washer, Branch | Driver task assigned/status change | `id`, `taskType`, `status`, `assignedDriverId` |
| `payment.status_updated` | Customer, Washer, Branch | Payment status change (e.g., paid, refunded) | `id`, `orderId`, `paymentStatus`, `amount` |
| `session.revoked` | Customer / Staff Session | Session security revocation notice | `sessionId`, `reason` |

---

## 6. Security & Data Scrubbing Guarantees

1. **No Credentials in Events:** Passwords, OTP codes, refresh tokens, and JWT secrets are strictly excluded from event payloads.
2. **Customer Data Isolation:** Customer sockets do NOT receive sensitive staff fields (such as `driverStaffMembershipId` or internal notes).
3. **No Direct Command Invocations:** Clients CANNOT emit custom business commands over Socket.IO. Any inbound client socket events (other than standard Socket.IO connection lifecycle) are blocked by the server.

---

## 7. Reconnection & Data Synchronization Strategy

1. **Deduplication:** Clients SHOULD deduplicate incoming events using `eventId` to handle potential duplicate deliveries during network glitches.
2. **At-Least-Once Delivery:** Events are delivered with at-least-once semantics. Strict global ordering across distinct entities is not guaranteed.
3. **Reconnection Refetch:** Upon socket reconnection (`socket.on('connect')`), clients MUST perform a lightweight REST fetch (e.g., `GET /orders/active`) to synchronize state that may have occurred during offline periods.

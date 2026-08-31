import ApiError from '../../helpers/apiError.js';

/**
 * 20 Canonical Order Statuses in Prisma Schema:
 * pending_pickup, pickup_assigned, driver_heading_to_pickup, driver_arrived_pickup,
 * delivered_to_laundry, received_in_laundry, sorting_in_progress, sorting_confirmed,
 * invoice_generated, payment_pending, payment_confirmed, drying, ironing, packaging,
 * ready_for_delivery, delivery_assigned, driver_heading_to_delivery, driver_arrived_delivery,
 * delivered, cancelled
 */
export const ORDER_STATUSES = Object.freeze({
  PENDING_PICKUP: 'pending_pickup',
  PICKUP_ASSIGNED: 'pickup_assigned',
  DRIVER_HEADING_TO_PICKUP: 'driver_heading_to_pickup',
  DRIVER_ARRIVED_PICKUP: 'driver_arrived_pickup',
  DELIVERED_TO_LAUNDRY: 'delivered_to_laundry',
  RECEIVED_IN_LAUNDRY: 'received_in_laundry',
  SORTING_IN_PROGRESS: 'sorting_in_progress',
  SORTING_CONFIRMED: 'sorting_confirmed',
  INVOICE_GENERATED: 'invoice_generated',
  PAYMENT_PENDING: 'payment_pending',
  PAYMENT_CONFIRMED: 'payment_confirmed',
  DRYING: 'drying',
  IRONING: 'ironing',
  PACKAGING: 'packaging',
  READY_FOR_DELIVERY: 'ready_for_delivery',
  DELIVERY_ASSIGNED: 'delivery_assigned',
  DRIVER_HEADING_TO_DELIVERY: 'driver_heading_to_delivery',
  DRIVER_ARRIVED_DELIVERY: 'driver_arrived_delivery',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled'
});

/**
 * Allowed State Transitions Map:
 * maps currentStatus -> Array of allowed target statuses
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [ORDER_STATUSES.PENDING_PICKUP]: [
    ORDER_STATUSES.PICKUP_ASSIGNED,
    ORDER_STATUSES.DRIVER_HEADING_TO_PICKUP,
    ORDER_STATUSES.DELIVERED_TO_LAUNDRY,
    ORDER_STATUSES.RECEIVED_IN_LAUNDRY,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.PICKUP_ASSIGNED]: [
    ORDER_STATUSES.DRIVER_HEADING_TO_PICKUP,
    ORDER_STATUSES.DRIVER_ARRIVED_PICKUP,
    ORDER_STATUSES.DELIVERED_TO_LAUNDRY,
    ORDER_STATUSES.RECEIVED_IN_LAUNDRY,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.DRIVER_HEADING_TO_PICKUP]: [
    ORDER_STATUSES.DRIVER_ARRIVED_PICKUP,
    ORDER_STATUSES.DELIVERED_TO_LAUNDRY,
    ORDER_STATUSES.RECEIVED_IN_LAUNDRY,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.DRIVER_ARRIVED_PICKUP]: [
    ORDER_STATUSES.DELIVERED_TO_LAUNDRY,
    ORDER_STATUSES.RECEIVED_IN_LAUNDRY,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.DELIVERED_TO_LAUNDRY]: [
    ORDER_STATUSES.RECEIVED_IN_LAUNDRY,
    ORDER_STATUSES.SORTING_IN_PROGRESS,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.RECEIVED_IN_LAUNDRY]: [
    ORDER_STATUSES.SORTING_IN_PROGRESS,
    ORDER_STATUSES.SORTING_CONFIRMED,
    ORDER_STATUSES.INVOICE_GENERATED,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.SORTING_IN_PROGRESS]: [
    ORDER_STATUSES.SORTING_CONFIRMED,
    ORDER_STATUSES.INVOICE_GENERATED,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.SORTING_CONFIRMED]: [
    ORDER_STATUSES.INVOICE_GENERATED,
    ORDER_STATUSES.PAYMENT_PENDING,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.INVOICE_GENERATED]: [
    ORDER_STATUSES.PAYMENT_PENDING,
    ORDER_STATUSES.PAYMENT_CONFIRMED,
    ORDER_STATUSES.DRYING,
    ORDER_STATUSES.READY_FOR_DELIVERY,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.PAYMENT_PENDING]: [
    ORDER_STATUSES.PAYMENT_CONFIRMED,
    ORDER_STATUSES.DRYING,
    ORDER_STATUSES.READY_FOR_DELIVERY,
    ORDER_STATUSES.CANCELLED
  ],
  [ORDER_STATUSES.PAYMENT_CONFIRMED]: [
    ORDER_STATUSES.DRYING,
    ORDER_STATUSES.IRONING,
    ORDER_STATUSES.PACKAGING,
    ORDER_STATUSES.READY_FOR_DELIVERY
  ],
  [ORDER_STATUSES.DRYING]: [
    ORDER_STATUSES.IRONING,
    ORDER_STATUSES.PACKAGING,
    ORDER_STATUSES.READY_FOR_DELIVERY
  ],
  [ORDER_STATUSES.IRONING]: [
    ORDER_STATUSES.PACKAGING,
    ORDER_STATUSES.READY_FOR_DELIVERY
  ],
  [ORDER_STATUSES.PACKAGING]: [
    ORDER_STATUSES.READY_FOR_DELIVERY
  ],
  [ORDER_STATUSES.READY_FOR_DELIVERY]: [
    ORDER_STATUSES.DELIVERY_ASSIGNED,
    ORDER_STATUSES.DRIVER_HEADING_TO_DELIVERY
  ],
  [ORDER_STATUSES.DELIVERY_ASSIGNED]: [
    ORDER_STATUSES.DRIVER_HEADING_TO_DELIVERY,
    ORDER_STATUSES.DRIVER_ARRIVED_DELIVERY,
    ORDER_STATUSES.DELIVERED
  ],
  [ORDER_STATUSES.DRIVER_HEADING_TO_DELIVERY]: [
    ORDER_STATUSES.DRIVER_ARRIVED_DELIVERY,
    ORDER_STATUSES.DELIVERED
  ],
  [ORDER_STATUSES.DRIVER_ARRIVED_DELIVERY]: [
    ORDER_STATUSES.DELIVERED
  ],
  [ORDER_STATUSES.DELIVERED]: [],
  [ORDER_STATUSES.CANCELLED]: []
});

/**
 * Statuses that can be cancelled by Customer:
 */
export const CUSTOMER_CANCELABLE_STATUSES = Object.freeze([
  ORDER_STATUSES.PENDING_PICKUP,
  ORDER_STATUSES.PICKUP_ASSIGNED,
  ORDER_STATUSES.DRIVER_HEADING_TO_PICKUP,
  ORDER_STATUSES.DRIVER_ARRIVED_PICKUP
]);

/**
 * Validates whether transition from currentStatus -> targetStatus is allowed.
 */
export function isAllowedTransition(currentStatus, targetStatus) {
  if (!currentStatus || !targetStatus) return false;
  if (currentStatus === targetStatus) return true; // Idempotent same-state check
  const allowed = ALLOWED_TRANSITIONS[currentStatus];
  return Array.isArray(allowed) && allowed.includes(targetStatus);
}

/**
 * Asserts valid state transition, multi-tenant isolation, actor permission, and preconditions.
 */
export function assertOrderTransition({
  order,
  targetStatus,
  actorContext,
  actionName = 'status_update'
}) {
  if (!order) {
    throw new ApiError(404, 'order_not_found', 'Order not found');
  }

  // 1. Same status is idempotent
  if (order.status === targetStatus) {
    return { isIdempotent: true, targetStatus };
  }

  // 2. Multi-Tenant Washer Isolation (evaluated BEFORE transition matrix to return 403 instead of 400 on cross-tenant attempts)
  const canonicalWasherId = actorContext.washerId;
  if (!canonicalWasherId || order.washerId !== canonicalWasherId) {
    throw new ApiError(403, 'forbidden', 'Washer context mismatch');
  }

  // 3. Branch Isolation (evaluated BEFORE transition matrix)
  if (actorContext.branchId && order.branchId && order.branchId !== actorContext.branchId) {
    throw new ApiError(403, 'forbidden', 'Branch context mismatch');
  }

  // 4. Validate Transition Matrix
  if (!isAllowedTransition(order.status, targetStatus)) {
    throw new ApiError(
      400,
      'invalid_transition',
      `Invalid order transition from '${order.status}' to '${targetStatus}'`
    );
  }

  // 5. Actor Authorization per Target Status & Action
  const role = actorContext.role;

  // Customer Actions
  if (actionName === 'customer_cancel' || (targetStatus === ORDER_STATUSES.CANCELLED && !role)) {
    if (!CUSTOMER_CANCELABLE_STATUSES.includes(order.status)) {
      throw new ApiError(400, 'order_cannot_be_cancelled', 'Order cannot be cancelled at this stage');
    }
  }

  // Driver Actions
  const isDriverTarget = [
    ORDER_STATUSES.PICKUP_ASSIGNED,
    ORDER_STATUSES.DRIVER_HEADING_TO_PICKUP,
    ORDER_STATUSES.DRIVER_ARRIVED_PICKUP,
    ORDER_STATUSES.DELIVERED_TO_LAUNDRY,
    ORDER_STATUSES.DELIVERY_ASSIGNED,
    ORDER_STATUSES.DRIVER_HEADING_TO_DELIVERY,
    ORDER_STATUSES.DRIVER_ARRIVED_DELIVERY,
    ORDER_STATUSES.DELIVERED
  ].includes(targetStatus);

  if (isDriverTarget && role) {
    const isStaffOrDriver = ['driver', 'washer_owner', 'washer_manager', 'worker', 'branch_manager'].includes(role);
    if (!isStaffOrDriver) {
      throw new ApiError(403, 'forbidden', 'Only staff or drivers can execute driver transitions');
    }
    // Driver assignment validation: driver must match if driverStaffMembershipId is already set
    const effectiveDriverId = actorContext.staffMembershipId || actorContext.userId;
    if (order.driverStaffMembershipId && order.driverStaffMembershipId !== effectiveDriverId && role === 'driver') {
      throw new ApiError(403, 'forbidden', 'Order is assigned to another driver');
    }
  }

  return { isIdempotent: false, targetStatus };
}

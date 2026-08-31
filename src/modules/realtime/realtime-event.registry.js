/**
 * Realtime Event Registry
 *
 * Every supported eventType must declare:
 *   - eventVersion  : number
 *   - eventKind     : 'client_event' | 'internal_command'
 *   - validateAggregate(aggregate)
 *
 * For 'client_event':
 *   - resolveRecipients(aggregate, prisma) → { identityIds: string[] }
 *   - buildClientPayload(aggregate)  → safe object with NO sensitive fields
 *
 * For 'internal_command':
 *   - executeCommand(aggregateId) → executes internal system logic (e.g., disconnect)
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns identityIds of all active staff managers (washer_owner, washer_manager)
 * with hasFullWasherAccess in a washer.
 */
async function resolveWasherManagers(washerId, prisma) {
  const memberships = await prisma.staffMembership.findMany({
    where: {
      washerId,
      status: 'active',
      role: { in: ['washer_owner', 'washer_manager'] },
      hasFullWasherAccess: true,
      identity: { status: 'active' }
    },
    select: { identityId: true }
  });
  return memberships.map(m => m.identityId);
}

/**
 * Resolves the identityId for a phone (if any active identity has it).
 */
async function resolveIdentityByPhone(phone, prisma) {
  if (!phone) return null;
  const identity = await prisma.identity.findFirst({
    where: { phone, status: 'active' },
    select: { id: true }
  });
  return identity ? identity.id : null;
}

// ─── Registry ──────────────────────────────────────────────────────────────────

const registry = new Map();

function getRegistryKey(eventType, eventVersion, eventKind) {
  return `${eventType}:v${eventVersion}:${eventKind}`;
}

function registerEvent(definition) {
  if (!definition.eventType || !definition.eventVersion || !definition.eventKind) {
    throw new Error('eventType, eventVersion, and eventKind are required');
  }
  const key = getRegistryKey(definition.eventType, definition.eventVersion, definition.eventKind);
  registry.set(key, definition);
}

// ─── staff_invitation.created ─────────────────────────────────────────────────

registerEvent({
  eventType: 'staff_invitation.created',
  eventVersion: 1,
  eventKind: 'client_event',
  validateAggregate(aggregate) {
    if (!aggregate || !aggregate.id) throw new Error('aggregate.id is required');
    if (!aggregate.washerId) throw new Error('aggregate.washerId is required');
  },
  async resolveRecipients(aggregate, prisma) {
    const identityIds = new Set();
    if (aggregate.phone) {
      const id = await resolveIdentityByPhone(aggregate.phone, prisma);
      if (id) identityIds.add(id);
    }
    const managers = await resolveWasherManagers(aggregate.washerId, prisma);
    managers.forEach(id => identityIds.add(id));
    return { identityIds: [...identityIds] };
  },
  buildClientPayload(aggregate) {
    return {
      invitationId: aggregate.id,
      washerId: aggregate.washerId,
      proposedRole: aggregate.proposedRole,
      status: aggregate.status,
      createdAt: aggregate.createdAt,
      expiresAt: aggregate.expiresAt
    };
  }
});

// ─── staff_invitation.resent ──────────────────────────────────────────────────

registerEvent({
  eventType: 'staff_invitation.resent',
  eventVersion: 1,
  eventKind: 'client_event',
  validateAggregate(aggregate) {
    if (!aggregate || !aggregate.id) throw new Error('aggregate.id is required');
    if (!aggregate.washerId) throw new Error('aggregate.washerId is required');
  },
  async resolveRecipients(aggregate, prisma) {
    const identityIds = new Set();
    if (aggregate.phone) {
      const id = await resolveIdentityByPhone(aggregate.phone, prisma);
      if (id) identityIds.add(id);
    }
    const managers = await resolveWasherManagers(aggregate.washerId, prisma);
    managers.forEach(id => identityIds.add(id));
    return { identityIds: [...identityIds] };
  },
  buildClientPayload(aggregate) {
    return {
      invitationId: aggregate.id,
      washerId: aggregate.washerId,
      proposedRole: aggregate.proposedRole,
      resendCount: aggregate.resendCount,
      expiresAt: aggregate.expiresAt
    };
  }
});

// ─── staff_invitation.revoked ─────────────────────────────────────────────────

registerEvent({
  eventType: 'staff_invitation.revoked',
  eventVersion: 1,
  eventKind: 'client_event',
  validateAggregate(aggregate) {
    if (!aggregate || !aggregate.id) throw new Error('aggregate.id is required');
    if (!aggregate.washerId) throw new Error('aggregate.washerId is required');
  },
  async resolveRecipients(aggregate, prisma) {
    const identityIds = new Set();
    if (aggregate.phone) {
      const id = await resolveIdentityByPhone(aggregate.phone, prisma);
      if (id) identityIds.add(id);
    }
    const managers = await resolveWasherManagers(aggregate.washerId, prisma);
    managers.forEach(id => identityIds.add(id));
    return { identityIds: [...identityIds] };
  },
  buildClientPayload(aggregate) {
    return {
      invitationId: aggregate.id,
      washerId: aggregate.washerId,
      revokedAt: aggregate.revokedAt
    };
  }
});

// ─── staff_invitation.accepted ────────────────────────────────────────────────

registerEvent({
  eventType: 'staff_invitation.accepted',
  eventVersion: 1,
  eventKind: 'client_event',
  validateAggregate(aggregate) {
    if (!aggregate || !aggregate.id) throw new Error('aggregate.id is required');
    if (!aggregate.washerId) throw new Error('aggregate.washerId is required');
    if (!aggregate.invitedByIdentityId) throw new Error('aggregate.invitedByIdentityId is required');
  },
  async resolveRecipients(aggregate, prisma) {
    const identityIds = new Set();
    // Use the inviter identity if it is still active and authorized
    if (aggregate.invitedByIdentityId) {
      const inviterMembership = await prisma.staffMembership.findFirst({
        where: { 
          identityId: aggregate.invitedByIdentityId, 
          washerId: aggregate.washerId,
          status: 'active',
          identity: { status: 'active' }
        },
        select: { identityId: true }
      });
      if (inviterMembership) {
        identityIds.add(inviterMembership.identityId);
      }
    }
    // Always include washer managers
    const managers = await resolveWasherManagers(aggregate.washerId, prisma);
    managers.forEach(id => identityIds.add(id));
    return { identityIds: [...identityIds] };
  },
  buildClientPayload(aggregate) {
    return {
      invitationId: aggregate.id,
      washerId: aggregate.washerId,
      acceptedAt: aggregate.acceptedAt
    };
  }
});

// ─── staff_membership.activated ───────────────────────────────────────────────

registerEvent({
  eventType: 'staff_membership.activated',
  eventVersion: 1,
  eventKind: 'client_event',
  validateAggregate(aggregate) {
    if (!aggregate || !aggregate.id) throw new Error('aggregate.id is required');
    if (!aggregate.washerId) throw new Error('aggregate.washerId is required');
    if (!aggregate.identityId) throw new Error('aggregate.identityId is required');
  },
  async resolveRecipients(aggregate, prisma) {
    const identityIds = new Set();
    // Include the activated identity if they are still active
    const identity = await prisma.identity.findFirst({
      where: { id: aggregate.identityId, status: 'active' },
      select: { id: true }
    });
    if (identity) {
      identityIds.add(identity.id);
    }
    // Include washer managers
    const managers = await resolveWasherManagers(aggregate.washerId, prisma);
    managers.forEach(id => identityIds.add(id));
    return { identityIds: [...identityIds] };
  },
  buildClientPayload(aggregate) {
    return {
      membershipId: aggregate.id,
      washerId: aggregate.washerId,
      role: aggregate.role,
      createdAt: aggregate.createdAt
    };
  }
});

// ─── INTERNAL COMMANDS ────────────────────────────────────────────────────────

import { SocketSessionControlService } from './socket-session-control.service.js';

registerEvent({
  eventType: 'socket.session.disconnect',
  eventVersion: 1,
  eventKind: 'internal_command',
  validateAggregate(aggregate) {
    if (!aggregate || !aggregate.id) throw new Error('aggregate.id is required for session');
  },
  async executeCommand(aggregateId) {
    // Call the disconnect logic. It operates on the SocketRoomFactory directly via the io instance.
    // It doesn't send a payload and resolves once the disconnect is requested.
    await SocketSessionControlService.disconnectSession(aggregateId);
  }
});

// ─── Order Events ────────────────────────────────────────────────────────────

registerEvent({
  eventType: 'order.created',
  eventVersion: 1,
  eventKind: 'client_event',
  validateAggregate(aggregate) {
    if (!aggregate || !aggregate.id) throw new Error('aggregate.id is required');
    if (!aggregate.washerId) throw new Error('aggregate.washerId is required');
    if (!aggregate.customerMembershipId) throw new Error('aggregate.customerMembershipId is required');
    if (!aggregate.status) throw new Error('aggregate.status is required');
  },
  async resolveRecipients(aggregate, prisma) {
    const washerIds = [aggregate.washerId];
    const branchIds = aggregate.branchId ? [aggregate.branchId] : [];
    const identityIds = [];
    const appIdentities = [];

    const customerMembership = await prisma.customerMembership.findUnique({
      where: { id: aggregate.customerMembershipId }
    });

    if (customerMembership) {
      if (aggregate.originCustomerApplicationId) {
        appIdentities.push({
          applicationId: aggregate.originCustomerApplicationId,
          identityId: customerMembership.identityId
        });
      } else {
        identityIds.push(customerMembership.identityId);
      }
    }

    if (aggregate.driverStaffMembershipId) {
      const driverMembership = await prisma.staffMembership.findUnique({
        where: { id: aggregate.driverStaffMembershipId }
      });
      if (driverMembership) {
        identityIds.push(driverMembership.identityId);
      }
    }

    return { washerIds, branchIds, identityIds, appIdentities };
  },
  buildClientPayload(aggregate) {
    return {
      orderId: aggregate.id,
      publicNumber: aggregate.publicNumber,
      status: aggregate.status,
      paymentStatus: aggregate.paymentStatus,
      paymentMethod: aggregate.paymentMethod,
      totalPrice: aggregate.totalPrice,
      washerId: aggregate.washerId,
      branchId: aggregate.branchId,
      createdAt: aggregate.createdAt,
      updatedAt: aggregate.updatedAt
    };
  }
});

registerEvent({
  eventType: 'order.status_updated',
  eventVersion: 1,
  eventKind: 'client_event',
  validateAggregate(aggregate) {
    if (!aggregate || !aggregate.id) throw new Error('aggregate.id is required');
    if (!aggregate.washerId) throw new Error('aggregate.washerId is required');
    if (!aggregate.customerMembershipId) throw new Error('aggregate.customerMembershipId is required');
    if (!aggregate.status) throw new Error('aggregate.status is required');
  },
  async resolveRecipients(aggregate, prisma) {
    const washerIds = [aggregate.washerId];
    const branchIds = aggregate.branchId ? [aggregate.branchId] : [];
    const identityIds = [];
    const appIdentities = [];

    const customerMembership = await prisma.customerMembership.findUnique({
      where: { id: aggregate.customerMembershipId }
    });

    if (customerMembership) {
      if (aggregate.originCustomerApplicationId) {
        appIdentities.push({
          applicationId: aggregate.originCustomerApplicationId,
          identityId: customerMembership.identityId
        });
      } else {
        identityIds.push(customerMembership.identityId);
      }
    }

    if (aggregate.driverStaffMembershipId) {
      const driverMembership = await prisma.staffMembership.findUnique({
        where: { id: aggregate.driverStaffMembershipId }
      });
      if (driverMembership) {
        identityIds.push(driverMembership.identityId);
      }
    }

    return { washerIds, branchIds, identityIds, appIdentities };
  },
  buildClientPayload(aggregate) {
    return {
      orderId: aggregate.id,
      publicNumber: aggregate.publicNumber,
      status: aggregate.status,
      paymentStatus: aggregate.paymentStatus,
      paymentMethod: aggregate.paymentMethod,
      totalPrice: aggregate.totalPrice,
      washerId: aggregate.washerId,
      branchId: aggregate.branchId,
      createdAt: aggregate.createdAt,
      updatedAt: aggregate.updatedAt
    };
  }
});

// ─── Payment Events ──────────────────────────────────────────────────────────

registerEvent({
  eventType: 'payment.status_updated',
  eventVersion: 1,
  eventKind: 'client_event',
  validateAggregate(aggregate) {
    if (!aggregate || !aggregate.id) throw new Error('aggregate.id is required');
    if (!aggregate.orderId) throw new Error('aggregate.orderId is required');
    if (!aggregate.status) throw new Error('aggregate.status is required');
  },
  async resolveRecipients(aggregate, prisma) {
    const order = await prisma.order.findUnique({
      where: { id: aggregate.orderId }
    });

    if (!order) {
      return { washerIds: [], branchIds: [], identityIds: [], appIdentities: [] };
    }

    const washerIds = [order.washerId];
    const branchIds = order.branchId ? [order.branchId] : [];
    const identityIds = [];
    const appIdentities = [];

    const customerMembership = await prisma.customerMembership.findUnique({
      where: { id: order.customerMembershipId }
    });

    if (customerMembership) {
      if (order.originCustomerApplicationId) {
        appIdentities.push({
          applicationId: order.originCustomerApplicationId,
          identityId: customerMembership.identityId
        });
      } else {
        identityIds.push(customerMembership.identityId);
      }
    }

    return { washerIds, branchIds, identityIds, appIdentities };
  },
  buildClientPayload(aggregate) {
    return {
      paymentId: aggregate.id,
      orderId: aggregate.orderId,
      amount: aggregate.amount,
      currency: aggregate.currency,
      status: aggregate.status,
      method: aggregate.method,
      createdAt: aggregate.createdAt,
      updatedAt: aggregate.updatedAt
    };
  }
});

// ─── DriverTask Events ────────────────────────────────────────────────────────

registerEvent({
  eventType: 'driver_task.created',
  eventVersion: 1,
  eventKind: 'client_event',
  validateAggregate(aggregate) {
    if (!aggregate || !aggregate.id) throw new Error('aggregate.id is required');
    if (!aggregate.orderId) throw new Error('aggregate.orderId is required');
    if (!aggregate.status) throw new Error('aggregate.status is required');
    if (!aggregate.taskType) throw new Error('aggregate.taskType is required');
  },
  async resolveRecipients(aggregate, prisma) {
    const order = await prisma.order.findUnique({
      where: { id: aggregate.orderId }
    });

    const washerIds = order ? [order.washerId] : [];
    const branchIds = (order && order.branchId) ? [order.branchId] : [];
    const identityIds = [];
    const appIdentities = [];

    if (order) {
      const customerMembership = await prisma.customerMembership.findUnique({
        where: { id: order.customerMembershipId }
      });

      if (customerMembership) {
        if (order.originCustomerApplicationId) {
          appIdentities.push({
            applicationId: order.originCustomerApplicationId,
            identityId: customerMembership.identityId
          });
        } else {
          identityIds.push(customerMembership.identityId);
        }
      }
    }

    if (aggregate.assignedDriverId) {
      const driverMembership = await prisma.staffMembership.findUnique({
        where: { id: aggregate.assignedDriverId }
      });
      if (driverMembership) {
        identityIds.push(driverMembership.identityId);
      }
    }

    return { washerIds, branchIds, identityIds, appIdentities };
  },
  buildClientPayload(aggregate) {
    return {
      taskId: aggregate.id,
      orderId: aggregate.orderId,
      taskType: aggregate.taskType,
      status: aggregate.status,
      assignedDriverId: aggregate.assignedDriverId,
      createdAt: aggregate.createdAt,
      updatedAt: aggregate.updatedAt
    };
  }
});

registerEvent({
  eventType: 'driver_task.updated',
  eventVersion: 1,
  eventKind: 'client_event',
  validateAggregate(aggregate) {
    if (!aggregate || !aggregate.id) throw new Error('aggregate.id is required');
    if (!aggregate.orderId) throw new Error('aggregate.orderId is required');
    if (!aggregate.status) throw new Error('aggregate.status is required');
    if (!aggregate.taskType) throw new Error('aggregate.taskType is required');
  },
  async resolveRecipients(aggregate, prisma) {
    const order = await prisma.order.findUnique({
      where: { id: aggregate.orderId }
    });

    const washerIds = order ? [order.washerId] : [];
    const branchIds = (order && order.branchId) ? [order.branchId] : [];
    const identityIds = [];
    const appIdentities = [];

    if (order) {
      const customerMembership = await prisma.customerMembership.findUnique({
        where: { id: order.customerMembershipId }
      });

      if (customerMembership) {
        if (order.originCustomerApplicationId) {
          appIdentities.push({
            applicationId: order.originCustomerApplicationId,
            identityId: customerMembership.identityId
          });
        } else {
          identityIds.push(customerMembership.identityId);
        }
      }
    }

    if (aggregate.assignedDriverId) {
      const driverMembership = await prisma.staffMembership.findUnique({
        where: { id: aggregate.assignedDriverId }
      });
      if (driverMembership) {
        identityIds.push(driverMembership.identityId);
      }
    }

    return { washerIds, branchIds, identityIds, appIdentities };
  },
  buildClientPayload(aggregate) {
    return {
      taskId: aggregate.id,
      orderId: aggregate.orderId,
      taskType: aggregate.taskType,
      status: aggregate.status,
      assignedDriverId: aggregate.assignedDriverId,
      createdAt: aggregate.createdAt,
      updatedAt: aggregate.updatedAt
    };
  }
});

// ─── Public API ───────────────────────────────────────────────────────────────

export class RealtimeEventRegistry {
  static getDefinition(eventType, eventVersion, eventKind) {
    const key = getRegistryKey(eventType, eventVersion, eventKind);
    return registry.get(key) || null;
  }
}

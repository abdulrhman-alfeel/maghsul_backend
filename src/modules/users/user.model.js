import prisma from '../../config/db.js';

const UserModel = {
  async findById(id) {
    const identity = await prisma.identity.findUnique({
      where: { id },
      include: {
        customerMemberships: { where: { status: 'active' } },
        staffMemberships: { where: { status: 'active' } },
      }
    });
    if (!identity) return null;

    const primaryStaff = identity.staffMemberships?.[0];
    const role = primaryStaff?.role || (identity.customerMemberships?.length ? 'customer' : 'customer');
    const washerId = primaryStaff?.washerId || identity.customerMemberships?.[0]?.washerId || null;

    return {
      id: identity.id,
      phone: identity.phone,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
      status: identity.status,
      role,
      washerId,
      createdAt: identity.createdAt,
      updatedAt: identity.updatedAt,
      customerMemberships: identity.customerMemberships,
      staffMemberships: identity.staffMemberships
    };
  },

  async upsertByPhone({ phone, name, role, washerId }) {
    const identity = await prisma.identity.upsert({
      where: { phone },
      update: {
        name: name || undefined,
      },
      create: {
        phone,
        name: name || null,
      }
    });

    if (washerId) {
      if (role && ['washer_owner', 'washer_manager', 'branch_manager', 'worker', 'driver', 'washer_admin'].includes(role)) {
        const mappedRole = role === 'washer_admin' ? 'washer_owner' : role;
        await prisma.staffMembership.upsert({
          where: { identityId_washerId: { identityId: identity.id, washerId } },
          update: { role: mappedRole, status: 'active' },
          create: { identityId: identity.id, washerId, role: mappedRole, status: 'active' }
        });
      } else {
        await prisma.customerMembership.upsert({
          where: { identityId_washerId: { identityId: identity.id, washerId } },
          update: { status: 'active' },
          create: { identityId: identity.id, washerId, status: 'active' }
        });
      }
    }

    return this.findById(identity.id);
  },

  async updateById(id, data) {
    const { phone, name, avatarUrl, status } = data;

    const updateData = {};
    if (phone !== undefined) updateData.phone = phone;
    if (name !== undefined) updateData.name = name;
    if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl;
    if (status !== undefined) updateData.status = status;

    if (Object.keys(updateData).length > 0) {
      await prisma.identity.update({
        where: { id },
        data: updateData
      });
    }

    return this.findById(id);
  },

  async deleteById(id) {
    return prisma.identity.update({
      where: { id },
      data: { status: 'deleted', deletedAt: new Date() }
    });
  }
};

export default UserModel;

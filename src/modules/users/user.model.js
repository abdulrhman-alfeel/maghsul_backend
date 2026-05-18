import prisma from '../../config/db.js';

const UserModel = {
  findById(id) {
    return prisma.user.findUnique({ where: { id } });
  },

  upsertByPhone({ phone, name, role, washerId }) {
    return prisma.user.upsert({
      where: { phone },
      update: {
        name: name || undefined,
        role,
        washerId: washerId || undefined
      },
      create: {
        phone,
        name: name || null,
        role,
        washerId: washerId || null
      }
    });
  },

  updateById(id, data) {
    const { phone, name, role, washerId, status, fcmToken, deviceType, tokenUpdatedAt, avatarUrl } = data;

    return prisma.user.update({
      where: { id },
      data: {
        phone: phone || undefined,
        name: name || undefined,
        role: role || undefined,
        washerId: washerId || undefined,
        status: status || undefined,
        fcmToken: fcmToken || undefined,
        deviceType: deviceType || undefined,
        tokenUpdatedAt: tokenUpdatedAt || undefined,
        avatarUrl: avatarUrl !== undefined ? avatarUrl : undefined
      }
    });
  },

  deleteById(id) {
    return prisma.user.delete({ where: { id } });
  }
};

export default UserModel;

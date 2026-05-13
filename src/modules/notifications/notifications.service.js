import prisma from '../../config/db.js';
import { sendPushToTokens } from './fcm.js';

function toStr(v, fallback = '') {
  return v === undefined || v === null ? fallback : String(v);
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  return payload;
}

const NotificationsService = {
  async createAndSendNotification(input) {
    const userId = toStr(input?.userId).trim();
    if (!userId) return null;

    const title = toStr(input?.title, 'إشعار جديد');
    const body = toStr(input?.body, '');
    const type = toStr(input?.type, '');
    const payload = normalizePayload(input?.payload);

    const notification = await prisma.notification.create({
      data: {
        userId,
        senderId: input?.senderId ? toStr(input.senderId) : null,
        title,
        body,
        type,
        entityId: input?.entityId ? toStr(input.entityId) : null,
        orderId: input?.orderId ? toStr(input.orderId) : null,
        role: input?.role ? toStr(input.role) : null,
        payload,
        isRead: false,
        isClicked: false,
      }
    });

    try {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { fcmToken: true } });
      const token = String(user?.fcmToken ?? '').trim();
      if (token) {
        const pushData = {
          type,
          targetScreen: toStr(payload?.targetScreen || ''),
          orderId: toStr(payload?.orderId || input?.orderId || ''),
          entityId: toStr(payload?.entityId || input?.entityId || ''),
          role: toStr(payload?.role || input?.role || ''),
          notificationId: notification.id,
          payload: JSON.stringify(payload ?? {}),
        };
        const res = await sendPushToTokens([token], { title, body, data: pushData });
        if (Array.isArray(res?.invalidTokens) && res.invalidTokens.includes(token)) {
          await prisma.user.update({ where: { id: userId }, data: { fcmToken: null, tokenUpdatedAt: new Date() } });
        }
      }
    } catch (_) {
      // ignore push failures
    }

    return notification;
  },

  async listUserNotifications(userId, opts = {}) {
    const take = Math.min(Math.max(Number(opts.limit) || 20, 1), 50);
    const cursor = opts.cursor ? toStr(opts.cursor) : null;
    const unreadOnly = Boolean(opts.unreadOnly);

    const where = {
      userId: toStr(userId),
      ...(unreadOnly ? { isRead: false } : {}),
    };

    const items = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
    });
    const nextCursor = items.length === take ? items[items.length - 1].id : null;
    return { items, nextCursor };
  },

  async unreadCount(userId) {
    return prisma.notification.count({ where: { userId: toStr(userId), isRead: false } });
  },

  async markRead(userId, id) {
    return prisma.notification.updateMany({
      where: { id: toStr(id), userId: toStr(userId) },
      data: { isRead: true },
    });
  },

  async markAllRead(userId) {
    return prisma.notification.updateMany({
      where: { userId: toStr(userId), isRead: false },
      data: { isRead: true },
    });
  },

  async markClicked(userId, id) {
    return prisma.notification.updateMany({
      where: { id: toStr(id), userId: toStr(userId) },
      data: { isClicked: true },
    });
  },
};

export default NotificationsService;

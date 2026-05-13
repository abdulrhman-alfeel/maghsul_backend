import NotificationsService from './notifications.service.js';
import { ok } from '../../helpers/apiResponse.js';

const NotificationsController = {
  async send(req, res) {
    const { userId, title, body, type, payload, orderId, entityId, role } = req.body;
    const data = await NotificationsService.createAndSendNotification({
      userId,
      title,
      body,
      type,
      payload,
      orderId,
      entityId,
      role,
      senderId: req.user?.userId ?? req.user?.id ?? null,
    });
    return ok(res, data, 'Notification sent');
  },

  async listMine(req, res) {
    const userId = req.user?.userId ?? req.user?.id;
    const data = await NotificationsService.listUserNotifications(userId, {
      limit: req.query.limit,
      cursor: req.query.cursor,
      unreadOnly: String(req.query.unreadOnly || '') === 'true',
    });
    return ok(res, data, 'Notifications fetched');
  },

  async unreadCount(req, res) {
    const userId = req.user?.userId ?? req.user?.id;
    const count = await NotificationsService.unreadCount(userId);
    return ok(res, { count }, 'Unread count fetched');
  },

  async markRead(req, res) {
    const userId = req.user?.userId ?? req.user?.id;
    await NotificationsService.markRead(userId, req.params.id);
    return ok(res, null, 'Notification marked as read');
  },

  async markAllRead(req, res) {
    const userId = req.user?.userId ?? req.user?.id;
    await NotificationsService.markAllRead(userId);
    return ok(res, null, 'All notifications marked as read');
  },

  async markClicked(req, res) {
    const userId = req.user?.userId ?? req.user?.id;
    await NotificationsService.markClicked(userId, req.params.id);
    return ok(res, null, 'Notification marked as clicked');
  },
};

export default NotificationsController;

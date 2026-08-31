export const NOTIFICATION_QUEUE_NAME = 'push-notifications-v2';
export const NOTIFICATION_JOB_NAME = 'notification.dispatch';

export function buildNotificationJobId(eventId) {
  if (!eventId || typeof eventId !== 'string') {
    throw new Error('eventId must be a non-empty string');
  }
  if (eventId.includes(':')) {
    throw new Error('eventId must not contain colon (:)');
  }
  return `notification-${eventId}`;
}

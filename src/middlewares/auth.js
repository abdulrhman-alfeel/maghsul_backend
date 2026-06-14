import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';

// مسارات مسموح بها لحسابات pending_deletion فقط
const PENDING_DELETION_ALLOWED_PATHS = [
  '/me/account/restore',
  '/me/account/deletion-status',
  '/me/account',  // DELETE request لطلب الحذف ذاته
];

export default async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ ok: false, error: 'Missing token' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    const userId = decoded.userId || decoded.id;
    if (userId) {
      const dbUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, washerId: true, status: true }
      });

      if (!dbUser) {
        return res.status(401).json({ ok: false, error: 'User record not found. Please login again.' });
      }

      // منع الحسابات المحذوفة نهائياً
      if (dbUser.status === 'deleted') {
        return res.status(403).json({
          ok: false,
          error: 'تم حذف هذا الحساب نهائياً ولا يمكن استخدامه.',
          code: 'ACCOUNT_DELETED'
        });
      }

      // حسابات pending_deletion: مسموح فقط بمسارات بعينها
      if (dbUser.status === 'pending_deletion') {
        const isAllowed = PENDING_DELETION_ALLOWED_PATHS.some(p => req.path === p || req.path.startsWith(p));
        if (!isAllowed) {
          return res.status(403).json({
            ok: false,
            error: 'حسابك مجدول للحذف. يمكنك فقط استعادة حسابك أو إتمام الحذف.',
            code: 'ACCOUNT_PENDING_DELETION'
          });
        }
      }

      req.user = { ...decoded, ...dbUser, userId: dbUser.id };
    }

    next();
  } catch (err) {
    if (err?.name === 'TokenExpiredError') {
      return res.status(401).json({ ok: false, error: 'Token expired. Please login again.' });
    }
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }
}


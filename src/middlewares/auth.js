import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';
import { TokenService } from '../modules/auth/services/token.service.js';

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

    let decoded;
    try {
      decoded = TokenService.verifyAccessToken(token);
    } catch (v2Err) {
      if (v2Err?.name === 'TokenExpiredError' || v2Err?.code === 'TOKEN_EXPIRED') {
        return res.status(401).json({ ok: false, error: 'Token expired. Please login again.', code: 'TOKEN_EXPIRED' });
      }
      // Fallback for legacy tokens
      try {
        decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET);
      } catch (err2) {
        if (err2?.name === 'TokenExpiredError') {
          return res.status(401).json({ ok: false, error: 'Token expired. Please login again.', code: 'TOKEN_EXPIRED' });
        }
        decoded = jwt.verify(token, process.env.JWT_SECRET);
      }
    }

    req.authContext = decoded;

    const userId = decoded.identityId || decoded.userId || decoded.id;
    if (userId) {
      const dbIdentity = await prisma.identity.findUnique({
        where: { id: userId },
        include: {
          staffMemberships: { where: { status: 'active' } },
          customerMemberships: { where: { status: 'active' } },
        }
      });

      if (!dbIdentity) {
        return res.status(401).json({ ok: false, error: 'User record not found. Please login again.' });
      }

      // منع الحسابات المحذوفة نهائياً
      if (dbIdentity.status === 'deleted') {
        return res.status(403).json({
          ok: false,
          error: 'تم حذف هذا الحساب نهائياً ولا يمكن استخدامه.',
          code: 'ACCOUNT_DELETED'
        });
      }

      // حسابات pending_deletion: مسموح فقط بمسارات بعينها
      if (dbIdentity.status === 'pending_deletion') {
        const isAllowed = PENDING_DELETION_ALLOWED_PATHS.some(p => req.path === p || req.path.startsWith(p));
        if (!isAllowed) {
          return res.status(403).json({
            ok: false,
            error: 'حسابك مجدول للحذف. يمكنك فقط استعادة حسابك أو إتمام الحذف.',
            code: 'ACCOUNT_PENDING_DELETION'
          });
        }
      }

      const matchingStaff = decoded.staffMembershipId
        ? dbIdentity.staffMemberships.find(s => s.id === decoded.staffMembershipId)
        : (decoded.washerId
            ? dbIdentity.staffMemberships.find(s => s.washerId === decoded.washerId)
            : dbIdentity.staffMemberships[0]);

      const resolvedRole = decoded.role || matchingStaff?.role || (dbIdentity.customerMemberships.length > 0 ? 'customer' : 'customer');
      const resolvedWasherId = decoded.washerId || matchingStaff?.washerId || dbIdentity.customerMemberships[0]?.washerId || null;
      const resolvedBranchId = decoded.branchId || null;
      const resolvedStaffMembershipId = decoded.staffMembershipId || matchingStaff?.id || null;

      const userContext = {
        ...decoded,
        id: dbIdentity.id,
        userId: dbIdentity.id,
        phone: dbIdentity.phone,
        name: dbIdentity.name,
        role: resolvedRole,
        washerId: resolvedWasherId,
        branchId: resolvedBranchId,
        staffMembershipId: resolvedStaffMembershipId,
        status: dbIdentity.status,
      };

      req.user = userContext;
      req.authContext = userContext;
    }

    next();
  } catch (err) {
    if (err?.name === 'TokenExpiredError' || err?.code === 'TOKEN_EXPIRED') {
      return res.status(401).json({ ok: false, error: 'Token expired. Please login again.' });
    }
    console.log('JWT Verify Error:', err.message);

    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }
}

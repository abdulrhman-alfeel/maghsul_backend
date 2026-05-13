import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';

export default async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ ok: false, error: 'Missing token' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    // console.log('req.user',req.user);

    // التحقق من وجود المستخدم وإثراء البيانات (لضمان وجود washerId و role الحيّ من القاعدة)
    const userId = decoded.userId || decoded.id;
    if (userId) {
      const dbUser = await prisma.user.findUnique({ 
        where: { id: userId }, 
        select: { id: true, role: true, washerId: true } 
      });
      if (!dbUser) {
        return res.status(401).json({ ok: false, error: 'User record not found. Please login again.' });
      }
      // إثراء req.user بالبيانات من قاعدة البيانات
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

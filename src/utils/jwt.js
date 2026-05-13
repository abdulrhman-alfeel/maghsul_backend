import jwt from 'jsonwebtoken';
export function signToken(payload) { return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' }); }

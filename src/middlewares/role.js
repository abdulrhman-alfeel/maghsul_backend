export default function role(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        ok: false,
        error: 'Forbidden',
        details: `This action requires one of: ${roles.join(', ')}. Your role: ${req.user.role || 'none'}.`
      });
    }
    next();
  };
}

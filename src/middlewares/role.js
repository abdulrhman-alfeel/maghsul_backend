export default function role(...roles) {
  return (req, res, next) => {
    if (!req.authContext) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (!roles.includes(req.authContext.role)) {
      return res.status(403).json({
        ok: false,
        error: 'Forbidden',
        details: `This action requires one of: ${roles.join(', ')}. Your role: ${req.authContext.role || 'none'}.`
      });
    }
    next();
  };
}

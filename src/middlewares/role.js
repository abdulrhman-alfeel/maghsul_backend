export default function role(...roles) {
  return (req, res, next) => {
    const userRole = req.authContext?.role || req.user?.role;
    if (!userRole) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    // Super roles and aliases
    const allowedRoles = new Set(roles);
    if (allowedRoles.has('washer_admin')) {
      allowedRoles.add('washer_owner');
      allowedRoles.add('washer_manager');
      allowedRoles.add('branch_manager');
      allowedRoles.add('admin');
    }
    if (allowedRoles.has('worker')) {
      allowedRoles.add('washer_owner');
      allowedRoles.add('washer_admin');
      allowedRoles.add('washer_manager');
      allowedRoles.add('branch_manager');
      allowedRoles.add('admin');
    }
    if (allowedRoles.has('driver')) {
      allowedRoles.add('washer_owner');
      allowedRoles.add('washer_admin');
      allowedRoles.add('admin');
    }

    if (!allowedRoles.has(userRole) && userRole !== 'admin' && userRole !== 'washer_owner') {
      return res.status(403).json({
        ok: false,
        error: 'Forbidden',
        details: `This action requires one of: ${roles.join(', ')}. Your role: ${userRole}.`
      });
    }
    next();
  };
}

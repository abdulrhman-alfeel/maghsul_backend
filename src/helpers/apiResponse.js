export function ok(res, data = null, message = 'Success', status = 200) {
  return res.status(status).json({ ok: true, message, data });
}

export function fail(res, error = 'Error', status = 500, details = null) {
  return res.status(status).json({ ok: false, error, details });
}

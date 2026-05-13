import logger from '../config/logger.js';

export default function requestLogger(req, res, next) {
  const startedAt = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    logger.info('%s %s %d - %dms', req.method, req.originalUrl, res.statusCode, ms, {
      requestId: req.requestId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: ms,
    });
  });
  next();
}

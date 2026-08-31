export default class ApiError extends Error {
  constructor(status = 500, code = 'INTERNAL_ERROR', message = 'Internal Server Error', details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

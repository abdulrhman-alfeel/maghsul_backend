export default class ApiError extends Error {
  constructor(status = 500, message = 'Internal Server Error', details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

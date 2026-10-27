/** A user-facing, expected failure with a stable machine code and HTTP status. */
export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what = 'Record') => new AppError('NOT_FOUND', `${what} was not found.`, 404);
export const forbidden = (message = 'You do not have permission to perform this action.') => new AppError('PERMISSION_DENIED', message, 403);
export const invalid = (message, details) => new AppError('VALIDATION_ERROR', message, 422, details);
export const conflict = (code, message) => new AppError(code, message, 409);

/** Convert any thrown value into a safe HTTP response body (no internals leak). */
export function toErrorResponse(error, log = console.error) {
  if (error instanceof AppError) {
    return { status: error.status, body: { error: error.code, message: error.message, details: error.details } };
  }
  log(error);
  return { status: 500, body: { error: 'INTERNAL_ERROR', message: 'Something went wrong. Try again or contact support.' } };
}

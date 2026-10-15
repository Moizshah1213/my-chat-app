import { ErrorCodes, type ErrorCode } from './constants.js';

/** Standard API error shape (consistent wire format per blueprint §10). */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new AppError(ErrorCodes.VALIDATION_FAILED, msg, 400, details);
export const unauthenticated = (msg = 'Authentication required') =>
  new AppError(ErrorCodes.UNAUTHENTICATED, msg, 401);
export const invalidCredentials = (msg = 'Invalid email or password') =>
  new AppError(ErrorCodes.INVALID_CREDENTIALS, msg, 401);
export const forbidden = (msg = 'You do not have permission') =>
  new AppError(ErrorCodes.FORBIDDEN, msg, 403);
export const notFound = (msg = 'Not found') => new AppError(ErrorCodes.NOT_FOUND, msg, 404);
export const conflict = (msg: string) => new AppError(ErrorCodes.CONFLICT, msg, 409);
export const rateLimited = (msg = 'Too many requests') =>
  new AppError(ErrorCodes.RATE_LIMITED, msg, 429);
export const tenantRequired = (msg = 'Tenant context required') =>
  new AppError(ErrorCodes.TENANT_REQUIRED, msg, 400);

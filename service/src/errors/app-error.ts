/**
 * Errors the CLIENT should see. Services throw these; the error handler
 * (middlewares/error-handler.ts) turns them into HTTP responses.
 * Anything that is NOT an AppError is a bug and becomes a generic 500.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(400, code, message, details);
  }
}
export class UnauthorizedError extends AppError {
  constructor(code = "unauthorized", message = "Missing or invalid credentials") {
    super(401, code, message);
  }
}
export class NotFoundError extends AppError {
  constructor(code: string, message: string) {
    super(404, code, message);
  }
}
export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details);
  }
}

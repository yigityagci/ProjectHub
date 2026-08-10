export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = new.target.name;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Your session has expired. Please log in again.") {
    super(401, "AUTH_REQUIRED", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found.") {
    super(404, "NOT_FOUND", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to perform this action.") {
    super(403, "FORBIDDEN", message);
  }
}

export class ValidationError extends AppError {
  // Optional per-field detail, currently populated only when this error is
  // constructed from a mail-control listener's 422 response (see
  // email/mail-control.client.ts) — the listener's re-validation can name
  // exactly which dotted field path failed, which a plain message string
  // can't carry on its own.
  readonly fieldErrors?: Record<string, string>;

  constructor(message = "Invalid input.", fieldErrors?: Record<string, string>) {
    super(422, "VALIDATION_ERROR", message);
    this.fieldErrors = fieldErrors;
  }
}

export class ConflictError extends AppError {
  constructor(message = "This request conflicts with the current state.") {
    super(409, "CONFLICT", message);
  }
}

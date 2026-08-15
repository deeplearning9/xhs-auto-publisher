export class NeedsAttentionError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "NeedsAttentionError";
  }
}

export class ValidationError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ValidationError";
  }
}

export class ExternalServiceError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ExternalServiceError";
  }
}

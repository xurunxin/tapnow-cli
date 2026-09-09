export class TapnowError extends Error {
  constructor(code, message, details = {}, next = []) {
    super(message); this.code = code; this.details = details; this.next = next;
  }
}
export function errorResult(error) {
  return { schemaVersion: 1, ok: false, error: {
    code: error.code || (error.name === 'ZodError' ? 'INVALID_WORKFLOW' : 'COMMAND_FAILED'),
    message: error.message, details: error.details || error.issues || {},
    requestId: error.requestId, retryable: false,
    next: error.next || ['Inspect the error and current state before retrying; never blindly retry a generation submission.'],
  } };
}

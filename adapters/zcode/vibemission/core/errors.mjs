// TaskPier core — error types.
// All tool-layer failures throw TaskPierError; the MCP facade maps these to
// structured tool errors, everything else becomes a generic internal error.

export class TaskPierError extends Error {
  /**
   * @param {string} code  stable machine-readable code
   * @param {string} message
   * @param {unknown} [data] optional structured detail
   */
  constructor(code, message, data = undefined) {
    super(message);
    this.name = 'TaskPierError';
    this.code = code;
    this.data = data;
  }
}

export const Codes = {
  ILLEGAL_TRANSITION: 'illegal_transition',
  MISSING_GUARD_FIELD: 'missing_guard_field',
  TASK_NOT_FOUND: 'task_not_found',
  TERMINAL_TASK: 'terminal_task',
  INVALID_INPUT: 'invalid_input',
  STORE_ERROR: 'store_error',
};

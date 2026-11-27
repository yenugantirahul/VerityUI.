export class ExecutionError extends Error {
  readonly status: 400 | 401 | 404 | 409 | 429;

  constructor(status: ExecutionError['status'], message: string) {
    super(message);
    this.name = 'ExecutionError';
    this.status = status;
  }
}

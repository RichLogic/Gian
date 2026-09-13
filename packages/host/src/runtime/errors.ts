export class ManagedRuntimeInstallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ManagedRuntimeInstallError';
  }
}

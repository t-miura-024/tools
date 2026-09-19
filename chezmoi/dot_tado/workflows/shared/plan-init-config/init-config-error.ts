export class InitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitConfigError";
  }
}

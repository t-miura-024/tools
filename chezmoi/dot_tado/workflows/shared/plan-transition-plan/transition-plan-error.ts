export class TransitionPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionPlanError";
  }
}

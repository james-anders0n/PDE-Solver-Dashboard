export interface ComputationControl {
  isCancelled: () => boolean;
}

export class ComputationCancelledError extends Error {
  constructor() {
    super("Background computation cancelled");
    this.name = "ComputationCancelledError";
  }
}

export function throwIfCancelled(control?: ComputationControl): void {
  if (control?.isCancelled()) throw new ComputationCancelledError();
}

import { DifitSpawnError } from "./difit-spawn-error.ts";

export function isDifitSpawnError(error: unknown): error is DifitSpawnError {
  return error instanceof DifitSpawnError;
}

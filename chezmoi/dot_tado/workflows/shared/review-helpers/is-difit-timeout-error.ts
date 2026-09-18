import { DifitTimeoutError } from "./difit-timeout-error.ts";

export function isDifitTimeoutError(error: unknown): error is DifitTimeoutError {
  return error instanceof DifitTimeoutError;
}

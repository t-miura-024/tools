import { DifitOutputTooLargeError } from "./difit-output-too-large-error.ts";

export function isDifitOutputTooLargeError(error: unknown): error is DifitOutputTooLargeError {
  return error instanceof DifitOutputTooLargeError;
}

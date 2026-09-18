import { VALID_REF_PATTERN } from "./valid-ref-pattern.ts";

export function isValidGitRefName(ref: string): boolean {
  if (!ref || ref.length > 200) return false;
  if (!VALID_REF_PATTERN.test(ref)) return false;
  if (ref.includes("..")) return false;
  if (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") || ref.includes("//"))
    return false;
  if (/[;|&$`"'<>(){}*?!\n\r]/.test(ref)) return false;
  return true;
}

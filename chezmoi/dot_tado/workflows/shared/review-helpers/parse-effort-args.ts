import type { Depth, Width } from "./types.ts";

export function parseEffortArgs(input: string): {
  width?: Width;
  depth?: Depth;
  base?: string;
  target?: string;
} {
  const result: { width?: Width; depth?: Depth; base?: string; target?: string } = {};
  const widthMatch = input.match(/width\s*=\s*(low|medium|high|xhigh|max)/i);
  if (widthMatch) result.width = widthMatch[1].toLowerCase() as Width;
  const depthMatch = input.match(/depth\s*=\s*(max|xhigh|high|medium|low)/i);
  if (depthMatch) result.depth = depthMatch[1].toLowerCase() as Depth;
  const baseMatch = input.match(/base\s*=\s*([^\s]+)/i);
  if (baseMatch) result.base = baseMatch[1];
  const targetMatch = input.match(/target\s*=\s*([^\s]+)/i);
  if (targetMatch) result.target = targetMatch[1];
  return result;
}

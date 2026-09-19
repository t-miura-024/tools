export function describeDifitCommentKey(key: string): string {
  const [type, filePath, side, line, body] = key.split("\u0000");
  const excerpt = body.length > 60 ? `${body.slice(0, 60)}…` : body;
  return `${type} ${filePath}:${line} [${side}] (${excerpt.replace(/\n/g, " ")})`;
}

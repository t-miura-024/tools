/** Issue body の最後の effort コメントのみを読む。欠落は既定値、不正は停止。 */
export function effortFromIssueBody(body: string | undefined): { width: string; depth: string } {
  const comments = [...(body ?? "").matchAll(/<!--\s*effort:.*?-->/gis)];
  const last = comments.at(-1)?.[0];
  if (!last) return { width: "medium", depth: "medium" };
  const match =
    /^<!--\s*effort:\s*width=(low|medium|high|xhigh|max)\s+depth=(low|medium|high|xhigh|max)\s*-->$/i.exec(
      last,
    );
  if (!match)
    throw new Error("Issue body の effort コメントが不正です。plan-create で修正してください");
  return { width: match[1].toLowerCase(), depth: match[2].toLowerCase() };
}

/// difit 由来の動的文字列をコードフェンスで隔離する決定論的前処理（純粋関数）。
/// blocking_threads の原文維持のため行頭 `#` のエスケープではなくフェンス隔離を優先する。
/// feedback 内に ``` が含まれる場合は 4 連フェンスで囲み、フェンスの早期終了を防ぐ。
export function isolateDifitFeedback(feedback: string): string {
  const fence = feedback.includes("```") ? "````" : "```";
  return `${fence}markdown\n${feedback}\n${fence}`;
}

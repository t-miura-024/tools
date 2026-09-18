/// PID のプロセスが生存しているか（signal 0 の送信可否）を返す。
/// `mt difit done` の後始末検証（state 消失に加えて記録 pid が終了したこと）に使う。
///
/// ESRCH（プロセス不在）のみ false。EPERM は対象プロセスが存在しても権限が
/// 無い場合に返るため生存（true）として扱い、孤児プロセスの見逃しを防ぐ
/// （死んだと誤認して後始末完了と判定しない fail-closed）。
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code !== "ESRCH";
  }
}

// Rust 側 `src/git/common.rs` の GIT_CONTEXT_ENV と同じ集合。
// git hook / ラッパーが設定する GIT_DIR 等が残っていると repo root の解決や
// difit の内部 git 呼び出しが実行文脈に引きずられるため除去する。
export const GIT_CONTEXT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
] as const;

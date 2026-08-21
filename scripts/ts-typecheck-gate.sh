#!/usr/bin/env bash
set -euo pipefail

# ts-typecheck-gate: tsc の出力からブロッキング対象（Cannot find name）のみを抽出し、
# 該当があれば exit 1、なければ exit 0（他エラーは警告として表示）。
# Q3 決定: 環境起因の Cannot find module 等は警告に留め、Cannot find name のみをブロックする。

OUTPUT="$(bunx tsc --noEmit --skipLibCheck --target ESNext --module ESNext --moduleResolution bundler --allowImportingTsExtensions --types bun-types,node $(find chezmoi -name '*.ts' -type f -not -path "*/node_modules/*") 2>&1 || true)"

if echo "$OUTPUT" | grep -q "Cannot find name"; then
  echo "$OUTPUT" | grep "Cannot find name" >&2
  echo "" >&2
  echo "ts-typecheck-gate: blocking error detected (Cannot find name)" >&2
  exit 1
fi

# ブロッキング対象外のエラーは警告として表示するが gate は通過させる
if [ -n "$OUTPUT" ]; then
  # 出力があれば警告として表示（既存の環境起因エラー等）
  echo "$OUTPUT" >&2
  echo "" >&2
  echo "ts-typecheck-gate: non-blocking warnings above (gate passes)" >&2
fi

exit 0

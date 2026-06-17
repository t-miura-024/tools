#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/docker.sh <command> [args...]

<command> に指定可能な値:
  up      Docker サービス群を起動 (docker compose ... up -d 相当)
  down    Docker サービス群を停止
  logs    Docker サービス群のログを表示 (-f 付き)
  ps      Docker サービス群の状態を表示
  その他   docker compose にそのまま渡される (例: pull / restart / stop / config)

docker/*/docker-compose.yml を glob して -f フラグで連結します。
例:
  scripts/docker.sh up
  scripts/docker.sh down
  scripts/docker.sh logs qdrant
USAGE
}

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
docker_dir="${repo_root}/docker"

if [[ ! -d "${docker_dir}" ]]; then
  echo "error: docker ディレクトリが見つかりません: ${docker_dir}" >&2
  exit 1
fi

compose_files=()
shopt -s nullglob
for compose_file in "${docker_dir}"/*/docker-compose.yml; do
  compose_files+=("-f" "${compose_file}")
done
shopt -u nullglob

if [[ ${#compose_files[@]} -eq 0 ]]; then
  echo "error: ${docker_dir}/*/docker-compose.yml に該当するファイルがありません" >&2
  exit 1
fi

command="$1"
shift

case "${command}" in
  up)
    exec docker compose "${compose_files[@]}" up -d "$@"
    ;;
  down)
    exec docker compose "${compose_files[@]}" down "$@"
    ;;
  logs)
    exec docker compose "${compose_files[@]}" logs -f "$@"
    ;;
  ps)
    exec docker compose "${compose_files[@]}" ps "$@"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    exec docker compose "${compose_files[@]}" "${command}" "$@"
    ;;
esac

# Docker サービス群

`mise run docker-*` タスクは `scripts/docker.sh` 経由で `docker/*/docker-compose.yml` をすべて検出し、`docker compose -f ... -f ...` に連結して実行します。新サービスを追加するときは `docker/<service>/docker-compose.yml` を 1 つ置くだけで自動検出されます。

## 起動・停止

```bash
mise run docker-up    # 全サービスを起動
mise run docker-down  # 全サービスを停止
mise run docker-logs  # ログを追尾
```

## 状態確認

```bash
scripts/docker.sh ps  # 全サービスの状態を表示
```

## サービス一覧

| Service | Port (REST) | Port (gRPC) | 用途 | 設定ファイル |
| --- | --- | --- | --- | --- |
| SearXNG | 8080 | - | メタ検索エンジン | `docker/searxng/settings.yml` |
| Qdrant | 6333 | 6334 | ベクトル DB | `docker/qdrant/docker-compose.yml` |

## サービス追加手順

1. `docker/<service>/docker-compose.yml` を作成
2. 必要に応じて設定ファイルを同ディレクトリに配置
3. `scripts/docker.sh` が自動検出するため、追加設定は不要

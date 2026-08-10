---
status: accepted
---

# herdr ワークスペーステンプレートの保存・反映方式

`mt herdr workspace template` は、herdr の raw socket 操作 `layout.export` / `layout.apply` を使って設定状態を取得・反映し、cwd を除いたテンプレートをユーザー共通 JSON に保存する。反映時は保存された cwd を参照せず、反映コマンドの実行時 cwd を全 pane に設定して `layout.apply` に渡す。herdr のタブ・pane 状態を mt 側で再構成せず、異なるワークスペースから同じテンプレートを再利用できることを優先するため、この方式を採用する。

## Considered Options

- `api snapshot` を解析して mt 側でテンプレート化・反映する: herdr の内部表現への依存と再構成処理が増え、`layout.export` / `layout.apply` との乖離が起きる。
- cwd をテンプレートへ保存する: 保存元ワークスペースのパスに固定され、別のワークスペースで再利用できない。
- ワークスペースまたはリポジトリ単位で JSON を保存する: ユーザー共通のテンプレート一覧を共有できない。

## Consequences

- テンプレートは cwd に依存せず、任意のワークスペースで再利用できる。
- 反映時は全 pane が同一の実行時 cwd を使う。
- raw socket の `layout.export` / `layout.apply` が herdr と `mt` の統合境界となり、herdr 側の契約変更時は `mt` の追従が必要になる。
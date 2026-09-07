---
status: accepted
---

# herdr タブテンプレート・複製の保存・反映方式

`mt herdr tab template` は、herdr の raw socket 操作 `layout.export` / `layout.apply` を使って単一タブの設定状態を取得・反映し、cwd を除いたタブテンプレートをユーザー共通 JSON に保存する。反映時は保存された cwd を参照せず、反映コマンドの実行時 cwd を全 pane に設定して `layout.apply` に渡す。`mt herdr tab duplicate` は同一ワークスペース内にタブを複製し、cwd・label を維持して複製先へフォーカスを移動する。ワークスペース用テンプレートとの誤適用を防ぐため、型・保存先を分離することを優先する。

## Considered Options

- ワークスペース用 `Template` 形式・保存先を共用する: 実装は最小だが、複数タブ用と単一タブ用の区別が運用依存になり、誤適用の原因になる。
- cwd をタブテンプレートへ保存する: 保存元タブのパスに固定され、別の場所での再利用ができない。
- 別ワークスペースへのタブ複製・cwd 上書き複製を初版に含める: 用途は広いが引数設計と cwd 写像仕様が追加で必要になり、最小核から外れる。

## Consequences

- タブテンプレートは `~/.config/mt/herdr/templates/tabs/<name>.json` に保存され、ワークスペース用と分離される。
- タブテンプレートは cwd に依存せず、任意のタブで再利用できる。反映時は全 pane が同一の実行時 cwd を使う。
- apply は実行中タブ自身を置換するため、確認の上で実行し、プロセス終了を明示する。
- raw socket の `layout.export` / `layout.apply` が herdr と `mt` の統合境界となり、herdr 側の契約変更時は `mt` の追従が必要になる。

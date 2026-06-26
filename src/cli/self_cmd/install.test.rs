// install.rs のテストは chezmoi バイナリの外部依存が必要なため、
// 外部プロセス呼び出しを伴わない挙動（env var 経由での chezmoi apply 引数組み立て）は
// `chezmoi::shared::tests` 側で検証する。
//
// install.test.rs は将来の self install 拡張用に残しておく。

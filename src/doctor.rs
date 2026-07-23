//! システム全体の健全性チェック（`mt doctor`）。
//!
//! chezmoi チェック・Docker サービス・ツールインストール状態 / drift を
//! 1 コマンドでまとめて診断する。実装本体は [`check`] に置く
//! （src/README.md ルール A: src 直下はインデックスのみ）。

mod check;

pub use check::run;

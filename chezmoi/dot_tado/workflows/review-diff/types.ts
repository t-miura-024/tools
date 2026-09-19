import type { DifitCheckOutput } from "../shared/review-helpers/types";
/// dry-run 検証で観測した選択ドリフトの問題（通常経路の fail 文言の切り替えに使う）。
export interface DifitDryRunDriftProblem {
  type: "violation" | "detected" | "undetectable";
  description: string;
}

/// collect-verdict の check が両経路（round limit 経路 / 通常経路）で共有する
/// dry-run 検証パイプラインの結果:
///
///   `mt difit check --dry-run` 実行 → stderr 回収 → parseDifitCheck → drift 契約検証 →
///   選択整合の反映 → difit-check.json 永続化 → canonicalize 突合
///
/// 経路ごとの非対称は、この戻り値の扱い（マッピング）にだけ現れる:
///   - round limit 経路: `persist-error` は error、それ以外はすべて fail
///     （human_gate の判断材料として理由に載せる）
///   - 通常経路: `ok` + matched のみ通過（passes=false でも次ラウンドへ pass）/
///     `no-gate-output` と `ok` + mismatch は fail / `command-error` と
///     `persist-error` は error
///
/// `selectionReasons` は呼び出し前に difitSelectionReasons(ctx) で解決して渡す。
/// 通常経路は不一致ならこの関数を呼ばずに fail 早期終端する（daemon に触れない）。
export type DifitDryRunVerification =
  | {
      kind: "ok";
      daemon: DifitCheckOutput;
      /// daemon と verdict の canonicalize 突合が一致したか。
      matched: boolean;
      /// drift none かつ選択整合 OK（false なら突合の信頼性は限定的）。
      selectionVerified: boolean;
      /// 検証で観測した問題（round limit 経路の理由文。空 = 問題なし）。
      issues: string[];
      /// drift の問題（通常経路の fail 文言の切り替え用。問題なしなら undefined）。
      drift?: DifitDryRunDriftProblem;
      stderr: string[];
    }
  | {
      /// difit コマンド実行の失敗（DifitOutputTooLargeError / DifitTimeoutError /
      /// DifitSpawnError）。通常経路は error、round limit 経路は検証不能の理由に含める。
      kind: "command-error";
      reasons: string[];
    }
  | {
      /// コマンドは完走したがゲート出力（JSON）を返さなかった（セッション不在等）。
      kind: "no-gate-output";
      stderr: string[];
    }
  | {
      /// difit-check.json へ永続化できなかった（両経路とも error）。
      kind: "persist-error";
      reasons: string[];
    };

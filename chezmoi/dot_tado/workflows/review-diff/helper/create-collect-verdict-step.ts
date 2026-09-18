import type { ArtifactRecord, CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import fs from "node:fs";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { validateVerdictJson } from "../../shared/review-helpers/validate-verdict-json";
import { validateFindingsJson } from "../../shared/review-helpers/validate-findings-json";
import { REVIEW_ROUND_LIMIT } from "../../shared/review-helpers/review-round-limit";
import { isRoundLimitReached } from "../../shared/review-helpers/is-round-limit-reached";
import { cleanupDifitSession } from "../../shared/review-helpers/cleanup-difit-session";
import { FINDINGS_KEY } from "../../shared/review-helpers/findings-key";
import { VERDICT_KEY } from "../../shared/review-helpers/verdict-key";
import { DIFIT_CHECK_KEY } from "../../shared/review-helpers/difit-check-key";
import { describeRecoveryCommand } from "./describe-recovery-command.ts";
import { difitSelectionReasons } from "./difit-selection-reasons.ts";
import { verifyDifitDryRun } from "./verify-difit-dry-run.ts";
/// 単独レビューは通過時に終了し、plan-run は人間承認までセッションを保持する。
export function createCollectVerdictStep(humanReviewPending: boolean): TaskStepDef {
  return {
    key: "collect-verdict",
    phase: "verdict 収集",
    type: "task",
    maxRetries: 1,
    onFail: { action: "escalate" },
    task: {
      action: "orchestrate",
      // NOTE(arch-1): ゲート分類（is_human_author / is_want / classify_body / thread_blocks）の
      // 権威は Rust の `src/difit/gate.rs`（`mt difit check` / `mt difit threads --json` が同一実装。
      // かつて参照していた `shared.rs` は `pub use` による再公開のみ）。
      // 分類規則の写像（写経）が残る箇所は以下に限定され、規則変更時は同時更新が必要:
      //   1. この collect-verdict プロンプト — `mt difit threads --json` の機械出力をそのまま
      //      verdict 化し、分類規則を再実装・再記述しない（写経なし）
      //   2. plan-run/index.ts — formatDifitFeedback（blocking_threads / want 昇格の表示説明）と
      //      execute_work プロンプト（resolve 運用の指示）
      //   3. agents 3 面 (dot_claude / dot_config/opencode / dot_cursor の mt-plan-work-executor.md)
      //      — resolve / want 昇格の判断説明
      //   4. index.test.ts — prompt / check の契約テスト
      buildPrompt: (ctx: PromptCtx) => {
        const verdictPath = join(ctx.sessionDir, VERDICT_KEY);
        const findingsPath = join(ctx.sessionDir, FINDINGS_KEY);
        return [
          "## 目的",
          "",
          humanReviewPending
            ? "difit の未 resolve スレッドから verdict.json を生成し、check が非破壊で突合する。人間レビュー前なので、通過・自律上限のいずれでもセッションを保持する。"
            : `difit の未 resolve スレッドから verdict.json を生成し、check が非破壊で突合する。一致した通過時に後始末する。ラウンド上限 ${REVIEW_ROUND_LIMIT} で終端する。`,
          "",
          "## 手順",
          "",
          "1. リポジトリルートで `mt difit threads --json` を実行し、state に固定された選択の未 resolve スレッドとゲート分類の機械出力を取得する（read-only。サーバ状態・state ファイルは変更されない）。",
          "   - `threads[].taxonomy` / `threads[].blocking` / `blocking_threads` は Rust のゲート分類（`mt difit check` と同一実装 `src/difit/gate.rs` の is_human_author / is_want / classify_body / thread_blocks）の出力であり、これが唯一の正。親 author / want 昇格 / ヘッダトークンの解釈をここで写経・再分類しない",
          "   - `mt difit threads --json` が失敗した場合（セッション不在・選択キー未記録・サーバ不応答。stdout に JSON が出ない）は verdict を生成せず error として報告する",
          "",
          `2. 機械出力から verdict.json (${verdictPath}) を生成する。blocking_threads は \`mt difit threads --json\` の blocking_threads（\`mt difit check\` の stdout と同一形状）をそのまま使い、body / replies / id / file / line を一字一句改変しない:`,
          "```json",
          '{ "round": 1, "width": "medium", "depth": "medium", "passed": false, "blocking_threads": [{ "id": "<thread id>", "file": "<filePath>", "line": 10, "taxonomy": "issue", "body": "<親 body 原文>", "replies": ["<reply body 原文>"] }], "findingsPath": "findings.json" }',
          "```",
          "   - passed は機械出力の `passes` をそのまま使う（blocking_threads が 0 件のとき true）",
          `   - round / width / depth は findings.json (${findingsPath}) から継承する。report に現在の round を明記する`,
          `3. JSON を ${verdictPath} に保存し、同じ JSON を report の subagentOutput として返す。report 時の artifacts に以下を含める（difit-check.json は check フェーズが \`mt difit check --dry-run\` の出力を永続化するファイル。task はパスを申告するだけで、内容の生成・編集は行わない。report 時点で未作成でもよい）:`,
          "```json",
          `[{"key":"${VERDICT_KEY}","path":"${verdictPath}"},{"key":"${DIFIT_CHECK_KEY}","path":"${join(ctx.sessionDir, DIFIT_CHECK_KEY)}"}]`,
          "```",
          humanReviewPending
            ? `4. 自律上限 ${REVIEW_ROUND_LIMIT} 到達時は残 must / should / want を difit 上に残して await-human-review へ渡す。追加ゲートは設けない。`
            : `4. round >= ${REVIEW_ROUND_LIMIT} かつ passed=false の場合は round limit reached (${REVIEW_ROUND_LIMIT}/${REVIEW_ROUND_LIMIT}) を報告する。`,
          "",
          "## 制約",
          "",
          "- `mt difit check` / `mt difit done` を実行しない（ゲート実行・後始末は check フェーズの責務。ここで実行すると daemon 出力との突合に必要なセッションが消える）。読み取りは `mt difit threads --json` のみ",
          "- difit サーバへ書き込まない（comment add / resolve / kill / 状態ファイルの変更は禁止）",
          "- verdict.json のスキーマ検証を必ず行う",
          "- blocking_threads の body 原文を要約・改変しない（daemon 出力と一致しない場合は check フェーズで fail になる）",
          "",
          "## セッション情報",
          "",
          `- セッションディレクトリ: ${ctx.sessionDir}`,
        ].join("\n");
      },
    },
    check: (ctx: CheckCtx): CheckResult => {
      if (ctx.attemptResult.status !== "completed") {
        return {
          status: "error",
          reasons: [ctx.attemptResult.errors ?? "collect-verdict failed"],
        };
      }

      // 先に verdict の形式と daemon 不要の前提（findings との round 一致・
      // must>0×passed 矛盾・effort.json と state.selection の整合）を検証する。
      // ここで止まる場合はゲート照会を実行しない（セッションを一切消費しない）。
      const verdictRaw =
        findArtifactText(ctx.artifacts as ArtifactRecord[], VERDICT_KEY, ctx.sessionDir) ??
        readSessionFile(ctx.sessionDir, VERDICT_KEY) ??
        ctx.attemptResult.subagentOutput;
      const verdictResult = validateVerdictJson(verdictRaw);
      if (!verdictResult.valid) {
        return {
          status: "error",
          reasons: [verdictResult.error ?? "verdict validation failed"],
        };
      }

      const verdict = verdictResult.parsed!;

      // daemon を必要としない前提検証を round limit 判定（isRoundLimitReached）より
      // 先に行う。上限経路は pass（単独レビューの上限停止）へ変換される唯一の
      // 通り抜けであり、findings との round 不一致や must>0×passed 矛盾を上限経路だけ
      // 素通りさせない。ここで止まる場合はセッションを消費しない。
      const findingsRaw2 =
        findArtifactText(ctx.artifacts as ArtifactRecord[], FINDINGS_KEY, ctx.sessionDir) ??
        readSessionFile(ctx.sessionDir, FINDINGS_KEY);
      const findingsResult2 = validateFindingsJson(findingsRaw2);
      if (findingsResult2.valid) {
        // verdict は findings の round を継承する契約（round limit 判定の前提）。
        // 不一致のまま daemon 突合へ進むと、古い round で上限判定が無音で無効化される。
        if (verdict.round !== findingsResult2.parsed!.round) {
          return {
            status: "fail",
            reasons: [
              `verdict.json の round=${verdict.round} が findings.json の round=${findingsResult2.parsed!.round} と不一致です。round は findings.json（effort.json を継承。plan-run では自律 loop の反復番号）から引き継いでください`,
            ],
          };
        }
        const mustCount = findingsResult2.parsed!.counts.must;
        if (mustCount > 0 && verdict.passed) {
          return {
            status: "fail",
            reasons: [`verdict passed=true but findings has must=${mustCount} blocking items`],
          };
        }
      }

      // ゲート前提（提示範囲 = 検証対象）の再検証。start-difit-review の check 通過後に
      // state.selection を別選択（空セッション等）へ書き換え、threads / dry-run に偽の
      // 通過を返させる TOCTOU を、通過・後始末の直前の再照合（start と同じ写像 =
      // expectedDifitSelection + validateDifitSelection）で検出する。
      const selectionReasons = difitSelectionReasons(ctx);

      if (!humanReviewPending && isRoundLimitReached(verdict)) {
        // 単独版の上限停止。検証結果を理由に残し、セッションは保持する。
        const verification = verifyDifitDryRun(ctx, verdict, selectionReasons);
        if (verification.kind === "persist-error") {
          return { status: "error", reasons: verification.reasons };
        }
        const verifyReasons: string[] = [];
        let dryRunStderr: string[];
        if (verification.kind === "ok") {
          verifyReasons.push(...verification.issues);
          const { daemon } = verification;
          if (verification.matched) {
            verifyReasons.push(
              verification.selectionVerified
                ? `daemon 突合 ok: passes=${daemon.passes} blocking=${daemon.blocking_threads.length}（verdict と一致。difit-check.json に保存）`
                : `daemon の passes=${daemon.passes} / blocking=${daemon.blocking_threads.length} は verdict と一致しますが、選択状態を検証できていないため突合の信頼性は限定的です（difit-check.json に保存）`,
            );
          } else {
            verifyReasons.push(
              `verdict が \`mt difit check --dry-run\` のゲート状態と不一致です (daemon passes=${daemon.passes} blocking=${daemon.blocking_threads.length}, verdict passed=${verdict.passed} blocking=${verdict.blocking_threads.length})。上限時点の検証としてこの不一致を人間判断に提示します`,
            );
          }
          dryRunStderr = verification.stderr;
        } else {
          // command-error / no-gate-output はどちらも「検証できていない」ことを
          // 明示して人間判断に委ねる（command-error のメッセージは stderr 枠に載せる）。
          verifyReasons.push(
            "`mt difit check --dry-run` からゲート出力を取得できなかったため、passes / blocking_threads / selection_drift を検証できていません（未検証であることを明示して human_gate の判断に委ねます）",
          );
          dryRunStderr =
            verification.kind === "command-error" ? verification.reasons : verification.stderr;
        }

        // ここで止まると difit セッション（サーバ・state）は保持されたままになる。
        // review-diff 単独では後始末するステップが無いため、終了時の後始末を案内する。
        return {
          status: "fail",
          reasons: [
            verdict.round > REVIEW_ROUND_LIMIT
              ? `round limit exceeded: round=${verdict.round} > ${REVIEW_ROUND_LIMIT}. 継続/中止を human_gate で選択してください`
              : `round limit reached (${REVIEW_ROUND_LIMIT}/${REVIEW_ROUND_LIMIT}) — verdict: passed=${verdict.passed}. 継続する場合は human_gate で選択してください`,
            ...verifyReasons,
            `difit セッション（サーバ・state）は保持しています。review-diff 単独実行ではこのまま終端するため、終了する場合は \`mt difit done\`（冪等・exit 0）で後始末してください`,
            ...dryRunStderr,
          ],
        };
      }

      if (selectionReasons.length > 0) {
        return {
          status: "fail",
          reasons: [
            ...selectionReasons,
            "ゲート前提（提示範囲 = 検証対象）を検証できないため、通過・後始末は行いません。選択状態を復旧してから `mt difit threads --json` の blocking_threads で verdict を再生成してください",
          ],
        };
      }

      // ゲートの権威判定は `mt difit check --dry-run`（非破壊）で行い、verdict と突合する。
      // 突合が一致するまでサーバ・状態を一切消費しないため、不一致の fail は
      // セッションを保持したまま復旧できる（実行不能な『verdict 再生成』要求は出さない。
      // task は `mt difit threads --json` の機械出力から verdict を作り直せる）。
      // 一致かつ通過のときだけ `mt difit done` を呼び、停止・状態削除を
      // 完了させる（ブロック時は次ラウンドの start-difit-review がセッションを再利用する）。
      //
      // 検証パイプラインは verifyDifitDryRun（round limit 経路と共有）に集約する。
      // この経路の非対称は「drift / 選択不整合 / 不一致 / ゲート出力なしは fail、
      // difit コマンドエラーは error」と分けること（選択不整合は上の早期 fail で
      // daemon に触れない）。
      const verification = verifyDifitDryRun(ctx, verdict, selectionReasons);
      if (verification.kind === "persist-error") {
        return { status: "error", reasons: verification.reasons };
      }
      if (verification.kind === "command-error") {
        return { status: "error", reasons: verification.reasons };
      }
      if (verification.kind === "no-gate-output") {
        return {
          status: "fail",
          reasons: [
            `\`mt difit check --dry-run\` がゲート出力 (passes / blocking_threads の JSON) を返しませんでした。difit セッションが存在しないか、選択キー未記録、同一性照合失敗、またはサーバ不応答です。${describeRecoveryCommand(ctx)} でセッションを開始/復旧してください。daemon 照合なしの通過は認めないため fail とします`,
            ...verification.stderr,
          ],
        };
      }
      const { daemon, drift, stderr: dryRunStderr } = verification;

      // 選択ドリフト（`mt difit check --dry-run` の検知）が `detected` なら、
      // verdict の一致と無関係に通過・後始末を認めない。UI の reply / resolve が
      // ゲートの読むセッションと別の場所へ書き込まれているため、復旧手順を示して
      // fail にする（セッションは保持され、セレクタを戻した後に再判定できる）。
      // フィールド欠落・解釈不能（契約違反）と probe 失敗の `unavailable`（検知不能）も
      // fail-closed で止める。
      if (drift) {
        return {
          status: "fail",
          reasons: [
            drift.description,
            drift.type === "violation"
              ? "difit CLI を更新した場合は `mt difit check --dry-run` の出力スキーマ（selection_drift の三値）を確認し、workflow 側を追従させてください"
              : drift.type === "detected"
                ? "difit UI のリビジョンセレクタを起動時の選択に戻して reply / resolve し直し、`mt difit threads --json` の blocking_threads から verdict を再生成してください"
                : `${describeRecoveryCommand(ctx)} でセッションを復旧し、difit UI の選択状態を確認したうえで \`mt difit threads --json\` の blocking_threads から verdict を再生成してください`,
            ...dryRunStderr,
          ],
        };
      }

      if (!verification.matched) {
        return {
          status: "fail",
          reasons: [
            `verdict does not match \`mt difit check --dry-run\` output (daemon passes=${daemon.passes} blocking=${daemon.blocking_threads.length}, verdict passed=${verdict.passed} blocking=${verdict.blocking_threads.length})`,
            "difit セッションは無破壊で保持されています。`mt difit threads --json` の blocking_threads を原文のまま verdict.json に写して再報告してください",
            ...dryRunStderr,
          ],
        };
      }

      // 一致かつ通過 → 唯一の後始末ポイント（停止・状態削除）。
      // 一致かつブロックなら後始末せず、次ラウンドへセッションを引き継ぐ。
      // 後始末（done 実行 + state 消失 + done 前 pid の終了検証）は shared の
      // cleanupDifitSession に集約し、人間承認後の completeHumanReviewStep と
      // 同一の検証規則を使う（片側だけ検証が弱い非対称を作らない）。
      let doneStderr: string[] = [];
      if (!humanReviewPending && daemon.passes) {
        const cleanup = cleanupDifitSession();
        doneStderr = cleanup.stderr;
        if (cleanup.status === "error") {
          return { status: "error", reasons: cleanup.reasons };
        }
        const done = cleanup.done!;
        // `mt difit done` の stdout は done 実行時点の**ゲート結果**であり、後始末の
        // 成否ではない（done は passes と無関係に close_session を実行する契約）。
        // passes=false は後始末失敗ではなく、dry-run 突合（passes=true）から done
        // 実行までの間に人間が未 resolve コメントを追加/返信する等してゲートが
        // ブロック（または判定不能）に変わったことを意味する。done の
        // blocking_threads は選択固定読み取り（state.selection）による done 時点の
        // 結果で、サーバ消滅後に得られる唯一の pinned read である。変化を握りつぶさず
        // この値を executor の feedback として永続化し、verdict 再生成（次ラウンド）へ倒す。
        if (!done.passes) {
          try {
            fs.writeFileSync(
              join(ctx.sessionDir, DIFIT_CHECK_KEY),
              `${JSON.stringify(done, null, 2)}\n`,
              "utf-8",
            );
          } catch (error) {
            return {
              status: "error",
              reasons: [`failed to persist difit done output: ${String(error)}`],
            };
          }
          const blocking = done.blocking_threads.map(
            (thread) =>
              `${thread.taxonomy ?? "blocking"} ${thread.file ?? "(file-level)"}: ${thread.body}`,
          );
          return {
            status: "fail",
            reasons: [
              `dry-run 突合 (passes=true) 後、\`mt difit done\` 実行時点のゲート結果が非通過に変わりました (done passes=false, blocking=${done.blocking_threads.length})。後始末（サーバ停止・状態削除）は done が passes と無関係に実行済みで、state 消失と pid 終了を確認済みです`,
              ...(blocking.length > 0
                ? blocking
                : [
                    `done 時点の blocking_threads は空です（差分・コメント取得の失敗、または判定不能）。${describeRecoveryCommand(ctx)} でセッションを開始し直してゲートを再判定してください`,
                  ]),
              "difit セッションは終了済みです。追加/返信された未 resolve スレッドは difit-check.json に記録しました。次ラウンドでこの blocking_threads を修正対象にし、verdict を再生成してください",
              ...doneStderr,
            ],
          };
        }
      }

      return {
        status: "pass",
        reasons: [
          `verdict: round=${verdict.round} passed=${verdict.passed} blocking=${verdict.blocking_threads.length} (daemon verified)`,
          ...dryRunStderr,
          ...doneStderr,
        ],
      };
    },
  };
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult } from 'tado';

export interface SddCheck {
  check_name: string;
  status: 'pass' | 'fail' | 'error';
  detail: string;
}

export function toCheckResult(checks: SddCheck[]): CheckResult {
  const errored = checks.filter((c) => c.status === 'error');
  if (errored.length > 0) {
    return { status: 'error', reasons: errored.map((c) => `${c.check_name}: ${c.detail}`) };
  }
  const failed = checks.filter((c) => c.status === 'fail');
  if (failed.length > 0) {
    return { status: 'fail', reasons: failed.map((c) => `${c.check_name}: ${c.detail}`) };
  }
  return { status: 'pass', reasons: checks.map((c) => `${c.check_name}: ${c.detail}`) };
}

function fileExists(filePath: string): SddCheck {
  const name = `${filePath.split('/').pop()}_exists`;
  if (!existsSync(filePath)) {
    return { check_name: name, status: 'fail', detail: `${filePath} not found` };
  }
  return { check_name: name, status: 'pass', detail: `${filePath} exists` };
}

function fileNoEmptySections(filePath: string): SddCheck {
  const name = `${filePath.split('/').pop()}_no_empty_sections`;
  if (!existsSync(filePath)) {
    return { check_name: name, status: 'error', detail: `${filePath} not found for content check` };
  }
  const content = readFileSync(filePath, 'utf-8');
  const emptySections = [
    ...content.matchAll(/^#{1,4}\s+[^\n]+\n{2,}(?:\n|#{1,4}\s)/gm),
  ];
  if (emptySections.length > 0) {
    return {
      check_name: name,
      status: 'fail',
      detail: `${emptySections.length} empty section(s) found in ${filePath}`,
    };
  }
  return { check_name: name, status: 'pass', detail: `no empty sections in ${filePath}` };
}

function fileNoTodos(filePath: string): SddCheck {
  const name = `${filePath.split('/').pop()}_no_todos`;
  if (!existsSync(filePath)) {
    return { check_name: name, status: 'error', detail: `${filePath} not found for TODO check` };
  }
  const content = readFileSync(filePath, 'utf-8');
  const todos = content.match(/TODO|FIXME|XXX/gi);
  if (todos && todos.length > 0) {
    return {
      check_name: name,
      status: 'fail',
      detail: `${todos.length} TODO/FIXME/XXX found in ${filePath}`,
    };
  }
  return { check_name: name, status: 'pass', detail: `no TODOs in ${filePath}` };
}

function fileHasSection(filePath: string, sectionPattern: RegExp, label: string): SddCheck {
  const name = `${filePath.split('/').pop()}_has_${label}`;
  if (!existsSync(filePath)) {
    return { check_name: name, status: 'error', detail: `${filePath} not found` };
  }
  const content = readFileSync(filePath, 'utf-8');
  if (!sectionPattern.test(content)) {
    return {
      check_name: name,
      status: 'fail',
      detail: `section "${label}" not found in ${filePath}`,
    };
  }
  return { check_name: name, status: 'pass', detail: `section "${label}" found in ${filePath}` };
}

function fileContains(filePath: string, pattern: RegExp, label: string): SddCheck {
  const name = `${filePath.split('/').pop()}_contains_${label}`;
  if (!existsSync(filePath)) {
    return { check_name: name, status: 'error', detail: `${filePath} not found` };
  }
  const content = readFileSync(filePath, 'utf-8');
  if (!pattern.test(content)) {
    return {
      check_name: name,
      status: 'fail',
      detail: `"${label}" not found in ${filePath}`,
    };
  }
  return { check_name: name, status: 'pass', detail: `"${label}" found in ${filePath}` };
}

// ---------------------------------------------------------------------------
// Phase 1 outputs
// ---------------------------------------------------------------------------

export function checkSpecWriterOutput(sessionDir: string): CheckResult {
  const specPath = join(sessionDir, 'spec.md');
  const logPath = join(sessionDir, 'appendix-hearing-log.md');
  const checks: SddCheck[] = [
    fileExists(specPath),
    fileExists(logPath),
    fileNoEmptySections(specPath),
    fileHasSection(specPath, /##\s+概要/, '概要'),
    fileHasSection(specPath, /##\s+背景/, '背景'),
    fileHasSection(specPath, /##\s+機能仕様/, '機能仕様'),
    fileHasSection(specPath, /##\s+受け入れ基準/, '受け入れ基準'),
  ];
  return toCheckResult(checks);
}

// ---------------------------------------------------------------------------
// Phase 2 outputs (spec review)
// ---------------------------------------------------------------------------

export function checkSpecReviewOutput(sessionDir: string): CheckResult {
  const reviewPath = join(sessionDir, 'appendix-spec-review.md');
  const checks: SddCheck[] = [
    fileExists(reviewPath),
    fileNoEmptySections(reviewPath),
    fileContains(reviewPath, /網羅性/, '網羅性'),
    fileContains(reviewPath, /実現可能性/, '実現可能性'),
    fileContains(reviewPath, /一貫性/, '一貫性'),
    fileContains(reviewPath, /リスク/, 'リスク'),
  ];
  return toCheckResult(checks);
}

// ---------------------------------------------------------------------------
// Process auditor checks (from process-auditor.md)
// ---------------------------------------------------------------------------

export function checkProcessAudit(sessionDir: string, artifacts: string[]): CheckResult {
  const checks: SddCheck[] = [];
  for (const artifact of artifacts) {
    const filePath = join(sessionDir, artifact);
    checks.push(fileExists(filePath));
    checks.push(fileNoEmptySections(filePath));
    checks.push(fileNoTodos(filePath));
  }
  return toCheckResult(checks);
}

export function checkUcrIntegrity(sessionDir: string, hasUcrReported: boolean): CheckResult {
  const logPath = join(sessionDir, 'appendix-change-log.md');
  const logExists = existsSync(logPath);
  if (hasUcrReported && !logExists) {
    return {
      status: 'fail',
      reasons: ['UCR was reported but appendix-change-log.md not found'],
    };
  }
  if (!hasUcrReported && logExists) {
    return {
      status: 'fail',
      reasons: ['appendix-change-log.md exists but no UCR was detected in this phase'],
    };
  }
  return { status: 'pass', reasons: ['UCR integrity check passed'] };
}

// ---------------------------------------------------------------------------
// Phase 4 outputs
// ---------------------------------------------------------------------------

export function checkImplPlanOutput(sessionDir: string): CheckResult {
  const planPath = join(sessionDir, 'implementation-plan.md');
  const checks: SddCheck[] = [
    fileExists(planPath),
    fileNoEmptySections(planPath),
    fileHasSection(planPath, /##\s+アプローチ/, 'アプローチ'),
    fileHasSection(planPath, /##\s+タスク一覧/, 'タスク一覧'),
    fileHasSection(planPath, /##\s+実行順序/, '実行順序'),
    fileHasSection(planPath, /##\s+変更ファイル/, '変更ファイル'),
  ];
  return toCheckResult(checks);
}

// ---------------------------------------------------------------------------
// Phase 5 outputs (plan review)
// ---------------------------------------------------------------------------

export function checkPlanReviewOutput(sessionDir: string): CheckResult {
  const reviewPath = join(sessionDir, 'appendix-plan-review.md');
  const checks: SddCheck[] = [
    fileExists(reviewPath),
    fileNoEmptySections(reviewPath),
    fileContains(reviewPath, /仕様適合/, '仕様適合'),
    fileContains(reviewPath, /アーキテクチャ/, 'アーキテクチャ'),
    fileContains(reviewPath, /タスク構造/, 'タスク構造'),
    fileContains(reviewPath, /リスク/, 'リスク'),
  ];
  return toCheckResult(checks);
}

// ---------------------------------------------------------------------------
// Phase 7 outputs (code review)
// ---------------------------------------------------------------------------

export function checkCodeReviewOutput(sessionDir: string): CheckResult {
  const reviewPath = join(sessionDir, 'appendix-code-review.md');
  const checks: SddCheck[] = [
    fileExists(reviewPath),
    fileNoEmptySections(reviewPath),
    fileContains(reviewPath, /総合判定/, '総合判定'),
  ];
  return toCheckResult(checks);
}

// ---------------------------------------------------------------------------
// Phase 8 outputs
// ---------------------------------------------------------------------------

export function checkValidationOutput(sessionDir: string): CheckResult {
  const reportPath = join(sessionDir, 'appendix-validation-report.md');
  const checks: SddCheck[] = [
    fileExists(reportPath),
    fileNoEmptySections(reportPath),
    fileContains(reportPath, /総合判定|適合|不適合/, '判定'),
  ];
  return toCheckResult(checks);
}

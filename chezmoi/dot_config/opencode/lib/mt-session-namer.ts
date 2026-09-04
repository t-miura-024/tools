// Managed by chezmoi: tools/chezmoi/dot_config/opencode/lib/mt-session-namer.ts
//
// mt-session-namer プラグインの純粋ロジック。テスト可能にするため
// プラグイン本体（../plugins/mt-session-namer.ts）から分離している。
// このディレクトリは opencode のプラグイン自動検出対象外のため、
// 値エクスポートを含めてもローダーに誤って呼び出されることはない。

export type ModelCosts = {
  cost?: {
    input?: unknown;
    output?: unknown;
  };
};

function comparableCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function compareCost(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

export function orderModelIDs(models: Record<string, ModelCosts> | undefined): string[] {
  return Object.entries(models ?? {})
    .map(([modelID, model], index) => ({ modelID, model, index }))
    .sort((a, b) => {
      const inputCost = compareCost(
        comparableCost(a.model.cost?.input),
        comparableCost(b.model.cost?.input),
      );
      if (inputCost !== 0) return inputCost;

      const outputCost = compareCost(
        comparableCost(a.model.cost?.output),
        comparableCost(b.model.cost?.output),
      );
      return outputCost !== 0 ? outputCost : a.index - b.index;
    })
    .map(({ modelID }) => modelID);
}

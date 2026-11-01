import type { Risk } from "../flow";

const LABELS: Record<Risk, string> = { high: "높은 위험", medium: "중간 위험", low: "낮은 위험" };

export function RiskTag({ risk }: { risk?: Risk }) {
  return risk ? <span className={`risk-tag ${risk}`}>{LABELS[risk]}</span> : null;
}

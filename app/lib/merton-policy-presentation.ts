export const MERTON_POLICY_UNIT = "dollar-allocation" as const;

export interface MertonPolicyPresentation {
  unit: typeof MERTON_POLICY_UNIT;
  nativeValue: string;
  analyticNativeValue: string;
  shareOfWealthValue: string | null;
  boundsValue: string;
  wealthValue: string;
  absoluteErrorValue: string;
}

const dollarFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatDollarAllocation(value: number): string {
  return Number.isFinite(value) ? dollarFormatter.format(value) : "—";
}

export function formatAllocationShareOfWealth(allocation: number, wealth: number): string | null {
  if (!Number.isFinite(allocation) || !Number.isFinite(wealth) || wealth <= 0) return null;
  return percentFormatter.format(allocation / wealth);
}

export function presentMertonPolicy(input: {
  policy: number;
  analyticPolicy: number;
  wealth: number;
  controlMin: number;
  controlMax: number;
  policyAbsoluteError: number;
}): MertonPolicyPresentation {
  return {
    unit: MERTON_POLICY_UNIT,
    nativeValue: formatDollarAllocation(input.policy),
    analyticNativeValue: formatDollarAllocation(input.analyticPolicy),
    shareOfWealthValue: formatAllocationShareOfWealth(input.policy, input.wealth),
    boundsValue: `${formatDollarAllocation(input.controlMin)} to ${formatDollarAllocation(input.controlMax)}`,
    wealthValue: formatDollarAllocation(input.wealth),
    absoluteErrorValue: formatDollarAllocation(input.policyAbsoluteError),
  };
}

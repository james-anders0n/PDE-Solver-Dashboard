import { createElement } from "react";

export function convergenceLevelKey(model: string, index: number, spaceSteps: number, varianceSteps: number | null, timeSteps: number): string {
  return `${model}-${spaceSteps}-${varianceSteps ?? "1d"}-${timeSteps}-${index}`;
}

export function ConvergenceLevelLabel({ index, grid }: { index: number; grid: string }) {
  return createElement("span", { "aria-label": `Convergence Level ${index + 1}` },
    createElement("b", null, `Level ${index + 1}`),
    createElement("small", null, grid),
  );
}


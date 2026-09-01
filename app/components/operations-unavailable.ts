import { createElement } from "react";

export function OperationsUnavailable({ message, onRetry }: { message: string; onRetry(): void }) {
  return createElement("section", { className: "operations-unavailable", role: "status", "aria-labelledby": "operations-unavailable-title" },
    createElement("div", null,
      createElement("b", { id: "operations-unavailable-title" }, "Forecast Operations unavailable"),
      createElement("p", null, message),
    ),
    createElement("dl", null,
      createElement("div", null, createElement("dt", null, "Unavailable"), createElement("dd", null, "Persistent run history, monitors, release schedule, retention status, and stored artifacts.")),
      createElement("div", null, createElement("dt", null, "Case impact"), createElement("dd", null, "Does not block Define, Condition, Solve, or the last-known-good forecast. It only limits the operational audit view.")),
      createElement("div", null, createElement("dt", null, "Configuration"), createElement("dd", null, "Configure the DB and FORECAST_ARTIFACTS bindings for the Operations API, then retry.")),
    ),
    createElement("button", { type: "button", onClick: onRetry }, "Retry Operations status"),
  );
}


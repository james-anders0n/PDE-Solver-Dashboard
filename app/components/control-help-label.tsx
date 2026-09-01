import { InfoPopover } from "@/app/components/info-popover";
import type { ControlHelp } from "@/app/lib/control-help";

export function ControlHelpLabel({ label, help, className = "" }: { label: string; help: ControlHelp; className?: string }) {
  return (
    <span className={`control-help-label ${className}`.trim()}>
      <InfoPopover className="label-with-info" label={label} trigger={label}>
        <p>{help.description}</p>
        <small>{help.context}</small>
      </InfoPopover>
    </span>
  );
}

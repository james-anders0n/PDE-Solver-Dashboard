"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type InfoPopoverProps = {
  label: string;
  children: ReactNode;
  className?: string;
  trigger?: ReactNode;
};

type PopoverPosition = {
  left: number;
  top: number;
  maxHeight: number;
};

export function InfoPopover({ label, children, className = "", trigger }: InfoPopoverProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const suppressFocusRef = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const open = hovered || focused || pinned;

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;
      const margin = 12;
      const gap = 8;
      const triggerBounds = trigger.getBoundingClientRect();
      const popoverBounds = popover.getBoundingClientRect();
      const maxHeight = Math.max(120, window.innerHeight - margin * 2);
      const below = triggerBounds.bottom + gap;
      const above = triggerBounds.top - popoverBounds.height - gap;
      const top = below + popoverBounds.height <= window.innerHeight - margin || above < margin ? below : above;
      const centredLeft = triggerBounds.left + triggerBounds.width / 2 - popoverBounds.width / 2;
      const left = Math.min(
        window.innerWidth - popoverBounds.width - margin,
        Math.max(margin, centredLeft),
      );
      setPosition({ left, top: Math.max(margin, top), maxHeight });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, children]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setPinned(false);
      setHovered(false);
      setFocused(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPinned(false);
      setHovered(false);
      setFocused(false);
      suppressFocusRef.current = true;
      triggerRef.current?.focus();
      queueMicrotask(() => { suppressFocusRef.current = false; });
    };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);

  const closePinnedPopover = () => {
    setPinned(false);
    setHovered(false);
    setFocused(false);
    suppressFocusRef.current = true;
    triggerRef.current?.focus();
    queueMicrotask(() => { suppressFocusRef.current = false; });
  };

  return (
    <span className={`info-popover-anchor ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className={`info-trigger ${trigger ? "with-label" : ""} ${pinned ? "pinned" : ""}`.trim()}
        aria-label={`More information about ${label}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => { if (!suppressFocusRef.current) setFocused(true); }}
        onBlur={(event) => {
          if (popoverRef.current?.contains(event.relatedTarget as Node | null)) return;
          if (!pinned) setFocused(false);
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (pinned) closePinnedPopover();
          else setPinned(true);
        }}
      >
        {trigger && <span className="info-trigger-label">{trigger}</span>}
        <span className="info-trigger-icon" aria-hidden="true">i</span>
      </button>
      {typeof document !== "undefined" && open && createPortal(
        <div
          ref={popoverRef}
          id={id}
          className={`info-popover ${pinned ? "pinned" : "preview"} ${position ? "positioned" : ""}`}
          role={pinned ? "dialog" : "tooltip"}
          aria-label={pinned ? `${label} information` : undefined}
          style={position ? { left: position.left, top: position.top, maxHeight: position.maxHeight } : undefined}
        >
          <div className="info-popover-heading">
            <strong>{label}</strong>
            {pinned && <button type="button" onClick={closePinnedPopover} aria-label={`Close ${label} information`}>×</button>}
          </div>
          <div className="info-popover-content">{children}</div>
        </div>,
        document.body,
      )}
    </span>
  );
}

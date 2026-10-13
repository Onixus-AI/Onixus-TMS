import { useId } from "react";

/** The Onixus mark. Each copy gets its own gradient id, so several can share a page. */
export function OnixusLogo({ className = "logo" }: { className?: string }) {
  const id = useId();
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7ee0c3" />
          <stop offset="1" stopColor="#3987e5" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="11" fill="none" stroke={`url(#${id})`} strokeWidth="4" />
      <rect x="13" y="3" width="6" height="9" rx="2" fill={`url(#${id})`} />
    </svg>
  );
}

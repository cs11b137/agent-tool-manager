import { useId } from 'react';

/** atm app-icon mark (gradient tile + white `a` with terminal-cursor stem). Source: assets/logo/atm-icon.svg */
export function AtmMark({ size = 32, className }: { size?: number; className?: string }) {
  const gid = useId();
  return (
    <svg viewBox="0 0 256 256" width={size} height={size} className={className} aria-hidden focusable="false">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="256" y2="256" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0066FF" />
          <stop offset="1" stopColor="#8E6CFF" />
        </linearGradient>
      </defs>
      <rect width="256" height="256" rx="58" fill={`url(#${gid})`} />
      <g fill="#FFFFFF" transform="translate(128 128) scale(.78) translate(-111 -128)">
        <path fillRule="evenodd" d="M35 128A76 76 0 1 1 187 128A76 76 0 1 1 35 128ZM69 128A42 42 0 1 0 153 128A42 42 0 1 0 69 128Z" />
        <rect x="153" y="52" width="34" height="152" rx="10" />
      </g>
    </svg>
  );
}

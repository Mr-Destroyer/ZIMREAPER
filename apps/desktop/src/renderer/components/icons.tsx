import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = (props: IconProps) => ({
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...props,
});

export function ArrowLeftIcon(props: IconProps) {
  return <svg {...base(props)}><path d="m15 18-6-6 6-6" /></svg>;
}
export function ArrowRightIcon(props: IconProps) {
  return <svg {...base(props)}><path d="m9 18 6-6-6-6" /></svg>;
}
export function ReloadIcon(props: IconProps) {
  return <svg {...base(props)}><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" /></svg>;
}
export function PlusIcon(props: IconProps) {
  return <svg {...base(props)}><path d="M12 5v14M5 12h14" /></svg>;
}
export function XIcon(props: IconProps) {
  return <svg {...base(props)}><path d="M18 6 6 18M6 6l12 12" /></svg>;
}
export function LockIcon(props: IconProps) {
  return <svg {...base(props)}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
}
export function GlobeIcon(props: IconProps) {
  return <svg {...base(props)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;
}
export function AlertIcon(props: IconProps) {
  return <svg {...base(props)}><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>;
}
export function ShieldIcon(props: IconProps) {
  return <svg {...base(props)}><path d="M12 3 4 6v6c0 4.5 3.4 8.7 8 9 4.6-.3 8-4.5 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></svg>;
}
export function PanelIcon(props: IconProps) {
  return <svg {...base(props)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>;
}
export function StopIcon(props: IconProps) {
  return <svg {...base(props)}><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /></svg>;
}
export function PlayIcon(props: IconProps) {
  return <svg {...base(props)}><path d="m8 5 11 7-11 7V5Z" fill="currentColor" stroke="none" /></svg>;
}
export function HandIcon(props: IconProps) {
  return <svg {...base(props)}><path d="M8 11V6a2 2 0 0 1 4 0v5M12 11V4a2 2 0 0 1 4 0v7M16 11V6a2 2 0 0 1 4 0v8a7 7 0 0 1-7 7h-1a7 7 0 0 1-7-7v-3a2 2 0 0 1 4 0" /></svg>;
}
export function CursorIcon(props: IconProps) {
  return <svg {...base(props)}><path d="m4 3 7 17 2.2-6.8L20 11 4 3Z" fill="currentColor" stroke="none" /></svg>;
}
export function ChevronIcon(props: IconProps) {
  return <svg {...base(props)}><path d="m9 18 6-6-6-6" /></svg>;
}

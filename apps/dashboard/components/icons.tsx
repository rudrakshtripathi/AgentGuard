// Small inline icon set (stroke icons, 16px). Always paired with text; aria-hidden.
type P = { className?: string };
const base = (path: React.ReactNode, className = 'h-4 w-4') => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    {path}
  </svg>
);

export const CheckIcon = ({ className }: P) => base(<path d="M3 8.5l3 3 7-7" />, className);
export const XIcon = ({ className }: P) => base(<path d="M4 4l8 8M12 4l-8 8" />, className);
export const ClockIcon = ({ className }: P) => base(<><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></>, className);
export const ClockXIcon = ({ className }: P) =>
  base(<><path d="M13.5 7A6 6 0 1 0 8 14" /><path d="M8 4.5V8l2 1.2" /><path d="M11 11l3 3M14 11l-3 3" /></>, className);
export const SpinnerIcon = ({ className = 'h-4 w-4' }: P) => (
  <svg viewBox="0 0 16 16" className={`${className} animate-spin`} aria-hidden="true">
    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
    <path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
export const LinkIcon = ({ className }: P) => base(<><path d="M6.5 9.5l3-3" /><path d="M7 4.5l1-1a3 3 0 0 1 4.2 4.2l-1 1" /><path d="M9 11.5l-1 1a3 3 0 0 1-4.2-4.2l1-1" /></>, className);
export const ShieldIcon = ({ className }: P) => base(<><path d="M8 1.5l5 2v4c0 3-2.2 5.6-5 7-2.8-1.4-5-4-5-7v-4z" /><path d="M5.5 8l1.8 1.8L10.5 6.5" /></>, className);
export const AlertIcon = ({ className }: P) => base(<><path d="M8 2l6.5 11.5h-13z" /><path d="M8 6.5v3M8 11.5v.01" /></>, className);
export const InfoIcon = ({ className }: P) => base(<><circle cx="8" cy="8" r="6" /><path d="M8 7.5v3.5M8 5v.01" /></>, className);
export const GridIcon = ({ className }: P) => base(<><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></>, className);
export const PulseIcon = ({ className }: P) => base(<path d="M1.5 8h3l2-5 3 10 2-5h3" />, className);
export const InboxIcon = ({ className }: P) => base(<><path d="M2 9l2-6h8l2 6v4H2z" /><path d="M2 9h3.5l1 1.5h3l1-1.5H14" /></>, className);
export const LedgerIcon = ({ className }: P) => base(<><rect x="3" y="1.5" width="10" height="13" rx="1.5" /><path d="M5.5 5h5M5.5 8h5M5.5 11h3" /></>, className);
export const PlayIcon = ({ className }: P) => base(<path d="M5 3l8 5-8 5z" />, className);
export const LogoutIcon = ({ className }: P) => base(<><path d="M6 14H3V2h3" /><path d="M10 11l3-3-3-3M13 8H6" /></>, className);
export const ArrowLeftIcon = ({ className }: P) => base(<path d="M10 3L5 8l5 5" />, className);
export const MenuIcon = ({ className }: P) => base(<path d="M2 4h12M2 8h12M2 12h12" />, className);

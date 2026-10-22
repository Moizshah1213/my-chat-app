import { cva, type VariantProps } from 'class-variance-authority';
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Minimal, token-driven primitives (maintain the design system, no lib churn). */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md font-semibold text-sm outline-offset-2 transition focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:opacity-50 disabled:pointer-events-none',
  {
    defaultVariants: { variant: 'primary', size: 'md' },
    variants: {
      variant: {
        primary: 'bg-accent text-bg border-accent',
        secondary:
          'bg-surface-3 text-text-secondary border border-border-strong hover:bg-surface-4',
        ghost: 'bg-transparent text-text-secondary',
        danger:
          'bg-danger text-bg border-danger hover:bg-red-600 focus-visible:ring-danger',
      },
      size: {
        sm: 'px-2.5 py-1.5 text-xs',
        md: 'px-3 py-2 text-sm',
        lg: 'px-4 py-2.5 text-base',
      },
    },
  },
);

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold',
  {
    defaultVariants: { variant: 'default' },
    variants: {
      variant: {
        default: 'bg-surface-3 text-text-secondary',
        open: 'bg-success/15 text-success',
        closed: 'bg-danger/14 text-danger',
        pending: 'bg-warning/14 text-warning',
        assigned: 'bg-info/14 text-info',
        unread: 'bg-accent/16 text-accent',
      },
    },
  },
);

export const inputBase = 'w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text-primary outline-none transition focus:border-accent focus:bg-surface-2 focus:ring-1 focus:ring-accent/20 disabled:opacity-60';
export const textareaBase = `${inputBase} min-h-22 resize-y`;
export const selectBase = inputBase + ' cursor-pointer';

export const card = 'rounded-lg border border-border bg-surface p-4';
export const paper = 'rounded-lg border border-border bg-surface';

export function skeleton(cls?: string) {
  return `animate-pulse rounded-md bg-surface-3 ${cls ?? ''}`;
}

export function Icon({
  node,
  size = 18,
  className,
}: {
  node: React.ReactNode;
  size?: number;
  className?: string;
}) {
  return <span className={className} style={{ width: size, height: size }}>{node}</span>;
}

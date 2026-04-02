"use client";

import { cn } from "@/lib/utils";
import { type CSSProperties, memo, useMemo } from "react";

const shimmerTags = {
  p: "p",
  span: "span",
  div: "div",
} as const;

export type TextShimmerProps = {
  children: string;
  as?: keyof typeof shimmerTags;
  className?: string;
  duration?: number;
  spread?: number;
};

const ShimmerComponent = ({
  children,
  as: tag = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const Component = shimmerTags[tag];

  const dynamicSpread = useMemo(
    () => Math.max((children?.length ?? 0) * spread, 24),
    [children, spread]
  );

  const style = {
    "--shimmer-duration": `${duration}s`,
    "--shimmer-spread": `${dynamicSpread}px`,
    backgroundImage:
      "linear-gradient(90deg, transparent calc(50% - var(--shimmer-spread)), var(--color-background) 50%, transparent calc(50% + var(--shimmer-spread))), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
  } as CSSProperties;

  return (
    <Component
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent [background-repeat:no-repeat,padding-box] animate-[nicole-text-shimmer_var(--shimmer-duration)_linear_infinite]",
        className
      )}
      style={style}
    >
      {children}
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);

"use client"

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { Shimmer } from "@/components/ai-elements/shimmer"

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

interface ReasoningContextType {
  isStreaming: boolean
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  duration: number | undefined
}

const ReasoningContext = createContext<ReasoningContextType | null>(null)

export function useReasoning() {
  const ctx = useContext(ReasoningContext)
  if (!ctx) throw new Error("useReasoning must be used inside <Reasoning />")
  return ctx
}

/* ------------------------------------------------------------------ */
/*  <Reasoning />                                                      */
/* ------------------------------------------------------------------ */

interface ReasoningProps
  extends Omit<
    React.ComponentProps<typeof Collapsible>,
    "open" | "onOpenChange"
  > {
  isStreaming?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  duration?: number
}

export function Reasoning({
  isStreaming = false,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  duration: externalDuration,
  children,
  className,
  ...props
}: ReasoningProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const isControlled = controlledOpen !== undefined
  const isOpen = isControlled ? controlledOpen : internalOpen

  const setIsOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next)
    onOpenChange?.(next)
  }

  // Track elapsed time while streaming
  const [duration, setDuration] = useState<number | undefined>(
    externalDuration
  )
  const startRef = useRef<number | null>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    if (isStreaming) {
      setIsOpen(true)
      startRef.current = Date.now()
      const tick = () => {
        if (startRef.current) {
          setDuration(Math.round((Date.now() - startRef.current) / 1000))
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } else {
      // streaming just ended — close panel
      if (startRef.current) {
        setDuration(Math.round((Date.now() - startRef.current) / 1000))
        startRef.current = null
      }
      cancelAnimationFrame(rafRef.current!)
      setIsOpen(false)
    }
    return () => cancelAnimationFrame(rafRef.current!)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming])

  return (
    <ReasoningContext.Provider
      value={{ isStreaming, isOpen, setIsOpen, duration: externalDuration ?? duration }}
    >
      <Collapsible
        open={isOpen}
        onOpenChange={setIsOpen}
        className={cn("w-full", className)}
        {...props}
      >
        {children}
      </Collapsible>
    </ReasoningContext.Provider>
  )
}

/* ------------------------------------------------------------------ */
/*  <ReasoningTrigger />                                               */
/* ------------------------------------------------------------------ */

interface ReasoningTriggerProps
  extends React.ComponentProps<typeof CollapsibleTrigger> {
  getThinkingMessage?: (
    isStreaming: boolean,
    duration?: number
  ) => ReactNode
}

export function ReasoningTrigger({
  getThinkingMessage,
  className,
  ...props
}: ReasoningTriggerProps) {
  const { isStreaming, isOpen, duration } = useReasoning()

  const defaultMessage = isStreaming
    ? `Thinking${duration != null && duration > 0 ? ` (${duration}s)` : ""}`
    : `Thought${duration != null && duration > 0 ? ` for ${duration}s` : ""}`

  const message = getThinkingMessage
    ? getThinkingMessage(isStreaming, duration)
    : defaultMessage

  return (
    <CollapsibleTrigger
      className={cn(
        "flex items-center gap-2 py-2 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer w-full text-left",
        className
      )}
      {...props}
    >
      {isStreaming ? (
        <Shimmer as="span" duration={2} spread={3}>
          {typeof message === "string" ? message : "Thinking..."}
        </Shimmer>
      ) : (
        <span>{message}</span>
      )}
    </CollapsibleTrigger>
  )
}

/* ------------------------------------------------------------------ */
/*  <ReasoningContent />                                               */
/* ------------------------------------------------------------------ */

interface ReasoningContentProps
  extends Omit<React.ComponentProps<typeof CollapsibleContent>, "children"> {
  children: string
}

export function ReasoningContent({
  children,
  className,
  ...props
}: ReasoningContentProps) {
  return (
    <CollapsibleContent
      className={cn(
        "overflow-hidden ml-2 pl-4 mb-2 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    >
      <div className="text-[11px] font-mono text-muted-foreground/70 leading-relaxed whitespace-pre-wrap py-1">
        {children}
      </div>
    </CollapsibleContent>
  )
}

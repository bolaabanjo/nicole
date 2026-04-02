"use client";

import { useState, useCallback, useRef } from "react";
import { ThumbsUp, ThumbsDown, Copy, Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface MessageActionsProps {
  messageText: string;
  onRegenerate?: () => void;
}

function MiniConfetti({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <span className="pointer-events-none absolute -top-3 left-1/2 -translate-x-1/2 flex gap-0.5">
      {["🎉", "✨", "🎊"].map((emoji, i) => (
        <span
          key={i}
          className="text-[8px] animate-confetti-pop"
          style={{
            animationDelay: `${i * 60}ms`,
            animationDuration: "500ms",
          }}
        >
          {emoji}
        </span>
      ))}
    </span>
  );
}

export function MessageActions({ messageText, onRegenerate }: MessageActionsProps) {
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const confettiTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleLike = useCallback(() => {
    if (liked) return;
    setLiked(true);
    setDisliked(false);
    setShowConfetti(true);
    clearTimeout(confettiTimeout.current);
    confettiTimeout.current = setTimeout(() => setShowConfetti(false), 600);
  }, [liked]);

  const handleDislike = useCallback(() => {
    if (disliked) return;
    setDisliked(true);
    setLiked(false);
    setShowConfetti(false);
  }, [disliked]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(messageText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [messageText]);

  return (
    <div className="flex items-center gap-1 pt-2">
      {/* Helpful */}
      <div className="relative">
        <MiniConfetti active={showConfetti} />
        <Button
          variant="ghost"
          size="icon"
          className={`h-6 w-6 cursor-pointer transition-colors ${
            liked
              ? "text-green-500 hover:text-green-400"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={handleLike}
          title="Helpful"
        >
          <ThumbsUp className="h-3 w-3" fill={liked ? "currentColor" : "none"} />
        </Button>
      </div>

      {/* Not helpful */}
      <Button
        variant="ghost"
        size="icon"
        className={`h-6 w-6 cursor-pointer transition-colors ${
          disliked
            ? "text-red-500 hover:text-red-400"
            : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={handleDislike}
        title="Not helpful"
      >
        <ThumbsDown className="h-3 w-3" fill={disliked ? "currentColor" : "none"} />
      </Button>

      {/* Copy */}
      <Button
        variant="ghost"
        size="icon"
        className={`h-6 w-6 cursor-pointer transition-colors ${
          copied
            ? "text-green-500 hover:text-green-400"
            : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={handleCopy}
        title={copied ? "Copied!" : "Copy"}
      >
        {copied ? (
          <Check className="h-3 w-3" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </Button>

      {/* Regenerate */}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
        onClick={onRegenerate}
        title="Regenerate"
      >
        <RotateCcw className="h-3 w-3" />
      </Button>
    </div>
  );
}

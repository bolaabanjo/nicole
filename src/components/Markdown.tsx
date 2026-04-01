"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";

function highlightCode(code: string) {
  if (!code) return code?.toString() || "";

  const keywords =
    /\b(const|let|var|function|return|if|else|for|while|import|export|from|async|await|class|interface|type|public|private|protected|try|catch|finally|def|in|is|not|and|or|print|new|this|super|extends|implements|static|void|null|undefined|true|false)\b/g;
  const strings = /("[^"]*"|'[^']*'|`[^`]*`)/g;
  const numbers = /\b\d+\.?\d*\b/g;
  const comments = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)/g;
  const functions = /\b([a-zA-Z_]\w*)(?=\()/g;
  const brackets = /([{}[\],])/g;

  const tokenizers = [
    { regex: comments, color: "color: #6b7280" },
    { regex: strings, color: "color: #4ade80" },
    { regex: keywords, color: "color: #c084fc" },
    { regex: functions, color: "color: #60a5fa" },
    { regex: numbers, color: "color: #fb923c" },
    { regex: brackets, color: "color: #facc15" },
  ];

  let segments: { text: string; color?: string }[] = [{ text: code }];

  for (const token of tokenizers) {
    const newSegments: { text: string; color?: string }[] = [];
    for (const segment of segments) {
      if (segment.color) {
        newSegments.push(segment);
        continue;
      }

      let lastIndex = 0;
      token.regex.lastIndex = 0;
      const text = segment.text;
      const matches = Array.from(text.matchAll(token.regex));

      if (matches.length === 0) {
        newSegments.push(segment);
        continue;
      }

      for (const m of matches) {
        if (m.index! > lastIndex) {
          newSegments.push({ text: text.slice(lastIndex, m.index!) });
        }
        newSegments.push({ text: m[0], color: token.color });
        lastIndex = m.index! + m[0].length;
      }
      if (lastIndex < text.length) {
        newSegments.push({ text: text.slice(lastIndex) });
      }
    }
    segments = newSegments;
  }

  return segments.map((s, i) => (
    <span key={i} style={s.color ? { [s.color.split(":")[0]]: s.color.split(":")[1].trim() } : undefined}>
      {s.text}
    </span>
  ));
}

export function Markdown({ content }: { content: string }) {
  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code);
  };

  return (
    <div className="max-w-none break-words text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            const isInline = !match && !className?.includes("language-");

            if (!isInline && match) {
              const language = match[1];
              const codeString = String(children).replace(/\n$/, "");

              return (
                <div
                  className="my-3 overflow-hidden"
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "6px",
                  }}
                >
                  <div
                    className="flex items-center justify-between px-3 py-1.5"
                    style={{
                      borderBottom: "1px solid var(--border)",
                      background: "rgba(255,255,255,0.03)",
                    }}
                  >
                    <span
                      className="font-mono uppercase tracking-wider"
                      style={{
                        fontSize: "10px",
                        color: "var(--muted)",
                      }}
                    >
                      {language}
                    </span>
                    <button
                      onClick={() => copyCode(codeString)}
                      className="transition-colors cursor-pointer"
                      style={{
                        fontSize: "10px",
                        color: "var(--muted)",
                      }}
                    >
                      copy
                    </button>
                  </div>
                  <pre
                    className="p-3 overflow-x-auto font-mono leading-relaxed m-0 border-0"
                    style={{
                      fontSize: "12px",
                      background: "transparent",
                    }}
                  >
                    <code>{highlightCode(codeString)}</code>
                  </pre>
                </div>
              );
            }

            return (
              <code
                className="font-mono"
                style={{
                  background: "rgba(255,255,255,0.08)",
                  padding: "2px 6px",
                  borderRadius: "3px",
                  fontSize: "12px",
                }}
                {...props}
              >
                {children}
              </code>
            );
          },
          table: ({ ...props }) => (
            <div
              className="my-4 w-full overflow-x-auto"
              style={{
                border: "1px solid var(--border)",
                borderRadius: "6px",
              }}
            >
              <table
                className="w-full text-sm"
                style={{ borderCollapse: "collapse" }}
                {...props}
              />
            </div>
          ),
          thead: ({ ...props }) => (
            <thead
              style={{
                borderBottom: "1px solid var(--border)",
                background: "rgba(255,255,255,0.03)",
              }}
              {...props}
            />
          ),
          tbody: ({ ...props }) => <tbody {...props} />,
          tr: ({ ...props }) => (
            <tr
              style={{ borderBottom: "1px solid var(--border)" }}
              {...props}
            />
          ),
          th: ({ ...props }) => (
            <th
              className="text-left text-sm font-medium"
              style={{ padding: "8px 12px", color: "var(--foreground)" }}
              {...props}
            />
          ),
          td: ({ ...props }) => (
            <td
              className="text-sm"
              style={{ padding: "8px 12px" }}
              {...props}
            />
          ),
          p: ({ ...props }) => (
            <p
              className="text-sm leading-relaxed mb-3 last:mb-0"
              {...props}
            />
          ),
          h1: ({ ...props }) => (
            <h1
              className="text-lg font-semibold mt-5 mb-2 leading-tight"
              {...props}
            />
          ),
          h2: ({ ...props }) => (
            <h2
              className="text-base font-semibold mt-4 mb-2 leading-tight"
              {...props}
            />
          ),
          h3: ({ ...props }) => (
            <h3
              className="text-sm font-semibold mt-3 mb-1.5 leading-snug"
              {...props}
            />
          ),
          h4: ({ ...props }) => (
            <h4
              className="text-sm font-medium mt-3 mb-1.5"
              {...props}
            />
          ),
          h5: ({ ...props }) => (
            <h5
              className="text-xs font-medium mt-2 mb-1"
              style={{ color: "var(--muted)" }}
              {...props}
            />
          ),
          h6: ({ ...props }) => (
            <h6
              className="text-xs font-mono uppercase tracking-wider mt-2 mb-1"
              style={{ color: "var(--muted)" }}
              {...props}
            />
          ),
          ul: ({ ...props }) => (
            <ul
              className="list-disc pl-5 mb-3 space-y-1 text-sm"
              {...props}
            />
          ),
          ol: ({ ...props }) => (
            <ol
              className="list-decimal pl-5 mb-3 space-y-1 text-sm"
              {...props}
            />
          ),
          li: ({ ...props }) => (
            <li
              className="pl-0.5 leading-relaxed"
              {...props}
            />
          ),
          a: ({ ...props }) => (
            <a
              className="underline underline-offset-2 transition-colors"
              style={{ color: "var(--muted)" }}
              target="_blank"
              rel="noopener noreferrer"
              {...props}
            />
          ),
          blockquote: ({ ...props }) => (
            <blockquote
              className="pl-3 my-3 italic"
              style={{
                borderLeft: "2px solid var(--border)",
                color: "var(--muted)",
              }}
              {...props}
            />
          ),
          hr: ({ ...props }) => (
            <hr
              className="my-4"
              style={{ borderColor: "var(--border)" }}
              {...props}
            />
          ),
          strong: ({ ...props }) => (
            <strong className="font-semibold" {...props} />
          ),
          em: ({ ...props }) => <em className="italic" {...props} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export type NicoleClientSurface = "web" | "pwa" | "macos" | "ios";

export interface NicoleWorkspaceContext {
  surface?: NicoleClientSurface;
  activeApp?: string;
  windowTitle?: string;
  selectedText?: string;
  clipboardText?: string;
  currentUrl?: string;
  currentFilePath?: string;
  visibleContent?: string;
  visualSummary?: string;
  visualElements?: string[];
  visualIssues?: string[];
  visualConfidence?: string;
  captureNotes?: string;
  note?: string;
}

export interface NicoleChatRequest {
  message: string;
  context?: NicoleWorkspaceContext;
  sessionId?: string;
  voice?: boolean;
  eventStream?: boolean;
}

const MAX_CONTEXT_FIELD_LENGTH = 1500;

function normalizeContextField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.slice(0, MAX_CONTEXT_FIELD_LENGTH);
}

function normalizeContextList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .map((item) => normalizeContextField(item))
    .filter((item): item is string => Boolean(item));

  return normalized.length > 0 ? normalized.slice(0, 8) : undefined;
}

export function normalizeWorkspaceContext(
  value: unknown
): NicoleWorkspaceContext | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const surface =
    raw.surface === "web" ||
    raw.surface === "pwa" ||
    raw.surface === "macos" ||
    raw.surface === "ios"
      ? raw.surface
      : undefined;

  const context: NicoleWorkspaceContext = {
    surface,
    activeApp: normalizeContextField(raw.activeApp),
    windowTitle: normalizeContextField(raw.windowTitle),
    selectedText: normalizeContextField(raw.selectedText),
    clipboardText: normalizeContextField(raw.clipboardText),
    currentUrl: normalizeContextField(raw.currentUrl),
    currentFilePath: normalizeContextField(raw.currentFilePath),
    visibleContent: normalizeContextField(raw.visibleContent),
    visualSummary: normalizeContextField(raw.visualSummary),
    visualElements: normalizeContextList(raw.visualElements),
    visualIssues: normalizeContextList(raw.visualIssues),
    visualConfidence: normalizeContextField(raw.visualConfidence),
    captureNotes: normalizeContextField(raw.captureNotes),
    note: normalizeContextField(raw.note),
  };

  return hasWorkspaceContext(context) ? context : undefined;
}

export function hasWorkspaceContext(
  context?: NicoleWorkspaceContext
): context is NicoleWorkspaceContext {
  if (!context) {
    return false;
  }

  return Boolean(
    context.surface ||
      context.activeApp ||
      context.windowTitle ||
      context.selectedText ||
      context.clipboardText ||
      context.currentUrl ||
      context.currentFilePath ||
      context.visibleContent ||
      context.visualSummary ||
      context.visualElements?.length ||
      context.visualIssues?.length ||
      context.visualConfidence ||
      context.captureNotes ||
      context.note
  );
}

export function formatWorkspaceContextForPrompt(
  context?: NicoleWorkspaceContext
): string | undefined {
  if (!hasWorkspaceContext(context)) {
    return undefined;
  }

  const lines = [
    context.surface ? `- Surface: ${context.surface}` : null,
    context.activeApp ? `- Active app: ${context.activeApp}` : null,
    context.windowTitle ? `- Window title: ${context.windowTitle}` : null,
    context.currentUrl ? `- Current URL: ${context.currentUrl}` : null,
    context.currentFilePath ? `- Current file path: ${context.currentFilePath}` : null,
    context.selectedText ? `- Selected text:\n"""${context.selectedText}"""` : null,
    context.clipboardText ? `- Clipboard:\n"""${context.clipboardText}"""` : null,
    context.visibleContent ? `- Visible content:\n"""${context.visibleContent}"""` : null,
    context.visualSummary ? `- Visual summary: ${context.visualSummary}` : null,
    context.visualElements?.length
      ? `- Important visual elements:\n${context.visualElements.map((item) => `  - ${item}`).join("\n")}`
      : null,
    context.visualIssues?.length
      ? `- Possible visual issues:\n${context.visualIssues.map((item) => `  - ${item}`).join("\n")}`
      : null,
    context.visualConfidence ? `- Visual confidence: ${context.visualConfidence}` : null,
    context.captureNotes ? `- Visual capture notes: ${context.captureNotes}` : null,
    context.note ? `- Client note: ${context.note}` : null,
  ].filter(Boolean);

  if (lines.length === 0) {
    return undefined;
  }

  return `${lines.join("\n")}\n\nTreat this as the user's current workspace. Use it when it helps. If it seems stale or incomplete, say that plainly instead of guessing.`;
}

export type NicoleClientSurface = "web" | "pwa" | "macos";

export interface NicoleWorkspaceContext {
  surface?: NicoleClientSurface;
  activeApp?: string;
  windowTitle?: string;
  selectedText?: string;
  clipboardText?: string;
  currentUrl?: string;
  currentFilePath?: string;
  visibleContent?: string;
  note?: string;
}

export interface NicoleChatRequest {
  message: string;
  context?: NicoleWorkspaceContext;
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

export function normalizeWorkspaceContext(
  value: unknown
): NicoleWorkspaceContext | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const surface =
    raw.surface === "web" || raw.surface === "pwa" || raw.surface === "macos"
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
    context.note ? `- Client note: ${context.note}` : null,
  ].filter(Boolean);

  if (lines.length === 0) {
    return undefined;
  }

  return `${lines.join("\n")}\n\nTreat this as the user's current workspace. Use it when it helps. If it seems stale or incomplete, say that plainly instead of guessing.`;
}

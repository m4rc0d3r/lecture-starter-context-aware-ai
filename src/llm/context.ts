import { type Fact, type Message, type Summary } from '../db/db';
import { SYSTEM_PROMPT } from './prompts';
import { type RetrievalResult } from '../embed/retriever';
import {
  estimateTokens as estimateTokensUtil,
  calculateTokenBudget,
  trimToTokenBudget,
} from '../utils/tokens';
import { traceLogger } from '../utils/trace-logger';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Estimate token count for a text string
 * Heuristic: ~4 characters per token for English text
 */
export function estimateTokens(text: string): number {
  return estimateTokensUtil(text);
}

/**
 * Validate user input length based on token budget
 * Returns error message if input exceeds limit, null otherwise
 */
export function validateUserInput(text: string, maxInputTokens?: number): string | null {
  const tokens = estimateTokens(text);
  const budget = calculateTokenBudget(maxInputTokens ?? 2000);

  if (tokens > budget.userMessageReserve) {
    return `Message too long: ${tokens} tokens (max ${budget.userMessageReserve} tokens). Please shorten your message.`;
  }

  return null;
}

/**
 * Context assembly configuration
 */
export interface ContextConfig {
  maxInputTokens: number;
  summary?: Summary | null;
  facts: Fact[];
  retrievedSnippets?: RetrievalResult[];
}

/**
 * Assembles context for LLM generation with dynamic token budget.
 * Phase 5: Full memory system with summary + retrieval + buffer
 *
 * Context structure:
 * 1. System prompt
 * 2. Rolling summary (if exists)
 * 3. Retrieved snippets (from semantic search)
 * 4. Recent buffer messages
 * 5. New user message (added by caller)
 */
export function assembleContext(recentMessages: Message[], config: ContextConfig): ChatMessage[] {
  const budget = calculateTokenBudget(config.maxInputTokens);

  const originalSummary = config.summary;
  const keptSummary = trimSummary(originalSummary, budget.summary);
  const snippetsThatFit = getFormattedSnippetsThatFit(
    config.retrievedSnippets ?? [],
    budget.retrieval
  );
  const formattedFacts = getFormattedFacts(config.facts, budget.facts);
  const recentBuffer = buildRecentBuffer(recentMessages, originalSummary, budget.buffer);

  const keptSummaryPrefix =
    originalSummary && originalSummary.text.length > keptSummary.length ? '...' : '';
  const systemText = [
    SYSTEM_PROMPT,
    keptSummary ? `## Summary\n\n${keptSummaryPrefix}${keptSummary}` : '',
    snippetsThatFit.length > 0 ? `## Relevant context\n\n${snippetsThatFit.join('\n\n')}` : '',
    formattedFacts.length > 0 ? `Known facts about the user:\n${formattedFacts.join('\n')}` : '',
  ].join('\n\n');

  const context: ChatMessage[] = [
    {
      role: 'system',
      content: systemText,
    },
    ...recentBuffer,
  ];

  if (originalSummary) {
    traceLogger.info('Context', 'Summary', {
      kept: keptSummary,
      trimmed: originalSummary.text.slice(
        0,
        originalSummary.text.length - (keptSummary?.length ?? 0)
      ),
    });
  } else {
    traceLogger.info('Context', 'There is no summary');
  }

  if (!config.retrievedSnippets) {
    traceLogger.info('Context', 'Retrieved snippets not provided');
  } else if (config.retrievedSnippets.length === snippetsThatFit.length) {
    traceLogger.info('Context', 'All retrieved snippets fit within the token limit');
  } else {
    traceLogger.info('Context', 'Snippets', {
      kept: snippetsThatFit,
      trimmed: config.retrievedSnippets.slice(snippetsThatFit.length),
    });
  }

  if (recentMessages.length === recentBuffer.length) {
    traceLogger.info('Context', 'All recent messages have been added to context');
  } else {
    traceLogger.info('Context', `Some recent messages are kept, some are deleted`, {
      kept: recentBuffer,
      trimmed: originalSummary
        ? recentMessages.filter((message) => message.timestamp <= originalSummary.upToTs)
        : recentMessages,
    });
  }

  if (formattedFacts.length === 0) {
    traceLogger.info('Context', 'No facts injected');
  } else {
    traceLogger.info('Context', `Some facts were injected`, {
      facts: formattedFacts,
    });
  }

  return context;
}

function trimSummary(summary: Summary | null | undefined, tokenBudget: number): string {
  if (!summary) {
    return '';
  }

  let text = summary.text;
  let trimmedLength = 0;

  while (text.length > 0 && estimateTokens(text) > tokenBudget) {
    trimmedLength += Math.floor(text.length * 0.1);
    text = text.slice(trimmedLength);
  }

  return text;
}

function getFormattedSnippetsThatFit(snippets: RetrievalResult[], tokenBudget: number): string[] {
  if (snippets.length === 0) {
    return [];
  }

  const formattedSnippets: string[] = [];
  let tokens = 0;

  for (let i = 0; i < snippets.length; ++i) {
    const snippet = snippets[i];
    const formatted = `[${i + 1}] (${getTimeAgo(snippet.message.timestamp)}, relevance: ${snippet.score.toFixed(
      2
    )}): ${snippet.message.text}`;

    const snippetTokens = estimateTokens(formatted);

    if (tokens + snippetTokens > tokenBudget) {
      break;
    }

    formattedSnippets.push(formatted);
    tokens += snippetTokens;
  }

  return formattedSnippets;
}

function getFormattedFacts(facts: Fact[], tokenBudget: number): string[] {
  if (facts.length === 0) {
    return [];
  }

  const sortedFacts = [...facts].sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);

  const formattedFacts: string[] = [];
  let tokens = 0;

  for (let i = 0; i < sortedFacts.length; ++i) {
    const { key, value } = sortedFacts[i];
    const formatted = `- ${key}: ${value}`;

    const factTokens = estimateTokens(formatted);

    if (tokens + factTokens > tokenBudget) {
      break;
    }

    formattedFacts.push(formatted);
    tokens += factTokens;
  }

  return formattedFacts;
}

function buildRecentBuffer(
  messages: Message[],
  summary: Summary | null | undefined,
  tokenBudget: number
): ChatMessage[] {
  const buffer = summary
    ? messages.filter((message) => message.timestamp > summary.upToTs)
    : messages;

  return trimToTokenBudget(buffer, tokenBudget).map((message) => ({
    role: message.role,
    content: message.text,
  }));
}

/**
 * Get human-readable time ago string
 */
function getTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

/**
 * Interactive flow engine for multi-step command flows.
 *
 * Uses async generators as coroutines: each flow yields prompt strings,
 * receives user reply strings, and returns a completion message string.
 *
 * The platform manager is responsible for sending prompt messages and
 * calling {@link registerFlowMessage} so the engine can correlate
 * future replies back to the correct flow.
 */

const FLOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** An async generator that yields prompts, receives replies, returns a final message. */
export type FlowGenerator = AsyncGenerator<string, string, string>;

export interface FlowReplyResult {
  type: 'prompt' | 'complete';
  message: string;
}

// ---------------------------------------------------------------------------
// Internal entry
// ---------------------------------------------------------------------------

interface FlowEntry {
  botId: string;
  channelId: string;
  userId: string;
  generator: FlowGenerator;
  /** All message IDs associated with this flow (for lookup). */
  messageIds: Set<string>;
  timeoutTimer: ReturnType<typeof setTimeout>;
  onExpire: () => void;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class InteractiveFlowManager {
  private readonly byMessage = new Map<string, FlowEntry>();
  private readonly byChannel = new Map<string, FlowEntry>();

  private key(botId: string, channelId: string): string {
    return `${botId}\0${channelId}`;
  }

  // -- Queries --------------------------------------------------------------

  /** Is this message ID part of an active flow? */
  isFlowMessage(messageId: string): boolean {
    return this.byMessage.has(messageId);
  }

  /** Is there an active flow for this bot + channel? */
  hasActiveFlow(botId: string, channelId: string): boolean {
    return this.byChannel.has(this.key(botId, channelId));
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Start a new interactive flow.
   * Any existing flow for the same bot + channel is cancelled first.
   */
  async startFlow(params: {
    botId: string;
    channelId: string;
    userId: string;
    generator: FlowGenerator;
    onExpire: () => void;
  }): Promise<FlowReplyResult> {
    const { botId, channelId, userId, generator, onExpire } = params;
    this.cancelFlow(botId, channelId);

    const first = await generator.next();
    if (first.done) {
      return { type: 'complete', message: first.value };
    }

    const entry: FlowEntry = {
      botId,
      channelId,
      userId,
      generator,
      messageIds: new Set(),
      timeoutTimer: setTimeout(() => {
        this.cleanup(entry);
        onExpire();
      }, FLOW_TIMEOUT_MS),
      onExpire,
    };

    this.byChannel.set(this.key(botId, channelId), entry);
    return { type: 'prompt', message: first.value };
  }

  /**
   * Register a sent prompt message so that replies to it are routed to this flow.
   *
   * - **Discord**: call for every prompt (each prompt is a new message).
   * - **Slack**: call once for the thread parent ts — all thread replies
   *   will reference it.
   */
  registerFlowMessage(botId: string, channelId: string, messageId: string): void {
    const entry = this.byChannel.get(this.key(botId, channelId));
    if (!entry) return;
    entry.messageIds.add(messageId);
    this.byMessage.set(messageId, entry);
  }

  /**
   * Process a user reply to a flow message.
   *
   * @returns result if the message belongs to a flow, otherwise `null`.
   */
  async handleReply(
    repliedToMessageId: string,
    content: string,
  ): Promise<FlowReplyResult | null> {
    const entry = this.byMessage.get(repliedToMessageId);
    if (!entry) return null;

    // Reset timeout
    clearTimeout(entry.timeoutTimer);
    entry.timeoutTimer = setTimeout(() => {
      this.cleanup(entry);
      entry.onExpire();
    }, FLOW_TIMEOUT_MS);

    const result = await entry.generator.next(content.trim());
    if (result.done) {
      this.cleanup(entry);
      return { type: 'complete', message: result.value };
    }
    return { type: 'prompt', message: result.value };
  }

  /** Cancel the active flow for a bot + channel. */
  cancelFlow(botId: string, channelId: string): boolean {
    const entry = this.byChannel.get(this.key(botId, channelId));
    if (!entry) return false;
    this.cleanup(entry);
    return true;
  }

  /** Shut down all active flows. */
  shutdown(): void {
    for (const entry of this.byChannel.values()) {
      clearTimeout(entry.timeoutTimer);
      entry.generator.return('').catch(() => undefined);
    }
    this.byMessage.clear();
    this.byChannel.clear();
  }

  // -- Internal -------------------------------------------------------------

  private cleanup(entry: FlowEntry): void {
    clearTimeout(entry.timeoutTimer);
    for (const id of entry.messageIds) {
      this.byMessage.delete(id);
    }
    this.byChannel.delete(this.key(entry.botId, entry.channelId));
    entry.generator.return('').catch(() => undefined);
  }
}

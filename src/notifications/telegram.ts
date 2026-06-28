import { httpRequest } from '../utils/http';
import type { INotificationService } from './types';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const POLL_TIMEOUT = 30;
const POLL_INTERVAL = 1_000;

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id: number };
  };
}

interface TelegramResponse {
  ok: boolean;
  result?: TelegramUpdate[];
}

export class TelegramService implements INotificationService {
  readonly id = 'telegram';
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateId = 0;
  private commandHandler?: (command: string, args: string) => void;
  private abortController: AbortController | null = null;
  private sendDisabled = false;
  private consecutiveFailures = 0;
  private disabledAt = 0;

  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly log?: (msg: string) => void,
  ) {}

  isEnabled(): boolean {
    return !!this.botToken && !!this.chatId;
  }

  async sendMessage(
    text: string,
    options?: { parseMode?: 'HTML' | 'Markdown' },
  ): Promise<void> {
    if (!this.isEnabled()) { return; }
    if (this.sendDisabled) {
      if (Date.now() - this.disabledAt > 5 * 60_000) {
        this.sendDisabled = false;
        this.consecutiveFailures = 0;
        this.log?.('[telegram] Re-enabling after cooldown...');
      } else {
        return;
      }
    }

    const url = `${TELEGRAM_API}${this.botToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id: this.chatId,
      text,
      parse_mode: options?.parseMode ?? 'HTML',
    });

    try {
      const resp = await httpRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        timeout: 10_000,
      });
      const data = JSON.parse(resp.body) as { ok: boolean; description?: string };
      if (!data.ok) {
        this.consecutiveFailures++;
        this.log?.(`[telegram] API error: ${data.description ?? 'unknown'}`);
        if (this.consecutiveFailures >= 2) {
          this.sendDisabled = true;
          this.log?.('[telegram] Too many failures — notifications disabled for this session. Check your botToken and chatId.');
        }
      } else {
        this.consecutiveFailures = 0;
      }
    } catch (err: unknown) {
      this.consecutiveFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      this.log?.(`[telegram] sendMessage failed: ${msg}`);
      if (this.consecutiveFailures >= 2) {
        this.sendDisabled = true;
        this.disabledAt = Date.now();
        this.log?.('[telegram] Too many failures — notifications paused for 5 min. Check your botToken and chatId.');
      }
    }
  }

  async start(): Promise<void> {
    if (!this.isEnabled() || this.polling) { return; }
    this.polling = true;
    this.abortController = new AbortController();
    this.poll();
  }

  async stop(): Promise<void> {
    this.polling = false;
    this.abortController?.abort();
    this.abortController = null;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  onCommand(handler: (command: string, args: string) => void): void {
    this.commandHandler = handler;
  }

  private async poll(): Promise<void> {
    if (!this.polling) { return; }

    try {
      const url = `${TELEGRAM_API}${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=${POLL_TIMEOUT}&allowed_updates=["message"]`;
      const response = await httpRequest(url, {
        method: 'GET',
        timeout: (POLL_TIMEOUT + 5) * 1_000,
        signal: this.abortController?.signal,
      });

      const data = JSON.parse(response.body) as TelegramResponse;

      if (data.ok && data.result?.length) {
        for (const update of data.result) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          this.handleUpdate(update);
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      // Network error — wait a bit before retrying
    }

    if (this.polling) {
      this.pollTimer = setTimeout(() => this.poll(), POLL_INTERVAL);
    }
  }

  private handleUpdate(update: TelegramUpdate): void {
    const text = update.message?.text?.trim();
    if (!text || !text.startsWith('/')) { return; }
    if (!this.commandHandler) { return; }

    // Only accept commands from the configured chat
    const msgChatId = update.message?.chat?.id?.toString();
    if (msgChatId !== this.chatId) { return; }

    // Parse: "/continue 10" → command="continue", args="10"
    const parts = text.slice(1).split(/\s+/);
    const command = parts[0].toLowerCase().replace(/@\w+$/, ''); // strip @botname
    const args = parts.slice(1).join(' ');

    this.commandHandler(command, args);
  }
}

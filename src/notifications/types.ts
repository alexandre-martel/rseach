export interface INotificationService {
  readonly id: string;
  isEnabled(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(text: string, options?: { parseMode?: 'HTML' | 'Markdown' }): Promise<void>;
  onCommand(handler: (command: string, args: string) => void): void;
}

import { EventEmitter } from 'events';
import type { ResearchSession, Trial } from './types';

export interface EventMap {
  'session:created': ResearchSession;
  'session:updated': ResearchSession;
  'session:deleted': string;
  'pipeline:started': { sessionId: string };
  'pipeline:stepStarted': { sessionId: string; stepId: string };
  'pipeline:stepProgress': { sessionId: string; stepId: string; progress: number; message?: string };
  'pipeline:stepCompleted': { sessionId: string; stepId: string };
  'pipeline:stepFailed': { sessionId: string; stepId: string; error: string };
  'pipeline:paused': { sessionId: string };
  'pipeline:resumed': { sessionId: string };
  'pipeline:completed': { sessionId: string };
  'pipeline:failed': { sessionId: string; error: string };
  'pipeline:cancelled': { sessionId: string };
  'hypertuning:trialStarted': { sessionId: string; trial: Trial };
  'hypertuning:trialCompleted': { sessionId: string; trial: Trial };
  'hypertuning:trialFailed': { sessionId: string; trial: Trial };
  'hypertuning:completed': { sessionId: string; bestTrialId: string };
  'llm:requestStarted': { provider: string; step: string };
  'llm:requestCompleted': { provider: string; step: string; tokens: number };
  'llm:budgetWarning': { usage: number; limit: number };
  'llm:budgetExceeded': { usage: number; limit: number };
}

export type EventName = keyof EventMap;

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  on<K extends EventName>(event: K, handler: (payload: EventMap[K]) => void): void {
    this.emitter.on(event, handler);
  }

  off<K extends EventName>(event: K, handler: (payload: EventMap[K]) => void): void {
    this.emitter.off(event, handler);
  }

  once<K extends EventName>(event: K, handler: (payload: EventMap[K]) => void): void {
    this.emitter.once(event, handler);
  }

  emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  dispose(): void {
    this.emitter.removeAllListeners();
  }
}

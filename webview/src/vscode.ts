declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

export function postMessage(type: string, payload?: unknown): void {
  vscode.postMessage({ type, payload });
}

export function onMessage(handler: (message: { type: string; payload?: unknown }) => void): void {
  window.addEventListener('message', (event) => {
    handler(event.data);
  });
}

export function getState<T>(): T | undefined {
  return vscode.getState() as T | undefined;
}

export function setState<T>(state: T): void {
  vscode.setState(state);
}

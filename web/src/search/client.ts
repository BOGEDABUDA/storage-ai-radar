/** 检索 Worker 的客户端封装：进度回调 + Promise 化查询。 */

import type { SearchHit } from '../lib/types';

export interface EngineQuery {
  q: string;
  categories?: string[];
  sections?: string[];
  from?: string;
  to?: string;
  limit?: number;
}

export interface EngineState {
  status: 'loading' | 'ready' | 'failed';
  loaded: number;
  total: number;
  count: number;
  warnings: string[];
}

export interface SearchEngine {
  state(): EngineState;
  onState(callback: (state: EngineState) => void): void;
  search(query: EngineQuery): Promise<{ hits: SearchHit[]; total: number }>;
}

export function createSearchEngine(base: string, dates: string[]): SearchEngine {
  const state: EngineState = { status: 'loading', loaded: 0, total: dates.length, count: 0, warnings: [] };
  const listeners = new Set<(s: EngineState) => void>();
  const pending = new Map<number, (value: { hits: SearchHit[]; total: number }) => void>();
  let nextId = 1;

  const emit = (): void => {
    for (const listener of listeners) listener({ ...state });
  };

  let worker: Worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  } catch (error) {
    state.status = 'failed';
    state.warnings.push(String(error));
    return {
      state: () => ({ ...state }),
      onState: (callback) => {
        callback({ ...state });
        listeners.add(callback);
      },
      search: async () => ({ hits: [], total: 0 }),
    };
  }

  worker.onmessage = (event: MessageEvent): void => {
    const message = event.data as {
      type: string;
      id?: number;
      loaded?: number;
      total?: number;
      count?: number;
      hits?: SearchHit[];
      message?: string;
    };

    switch (message.type) {
      case 'progress':
        state.loaded = message.loaded ?? state.loaded;
        emit();
        break;
      case 'ready':
        state.status = 'ready';
        state.count = message.count ?? 0;
        emit();
        break;
      case 'warning':
        if (message.message) state.warnings.push(message.message);
        emit();
        break;
      case 'results': {
        const resolve = message.id !== undefined ? pending.get(message.id) : undefined;
        if (resolve && message.id !== undefined) {
          pending.delete(message.id);
          resolve({ hits: message.hits ?? [], total: (message as { total?: number }).total ?? 0 });
        }
        break;
      }
      default:
        break;
    }
  };

  worker.onerror = (event): void => {
    state.status = 'failed';
    state.warnings.push(event.message || '未知 Worker 错误');
    emit();
  };

  worker.postMessage({ type: 'load', base, dates });

  return {
    state: () => ({ ...state }),
    onState: (callback) => {
      callback({ ...state });
      listeners.add(callback);
    },
    search: (query) =>
      new Promise((resolve) => {
        if (state.status === 'failed') {
          resolve({ hits: [], total: 0 });
          return;
        }
        const id = nextId++;
        pending.set(id, resolve);
        worker.postMessage({ type: 'query', id, ...query });
      }),
  };
}

/** Agent 面板的打开入口：让各页面无需直接依赖面板实现即可发起深挖。 */

type Opener = (question?: string) => void;

let opener: Opener | null = null;

export function registerAgentOpener(fn: Opener): void {
  opener = fn;
}

export function openAgent(question?: string): void {
  opener?.(question);
}

export function agentAvailable(): boolean {
  return opener !== null;
}

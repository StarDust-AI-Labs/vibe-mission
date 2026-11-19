/**
 * TaskPier host-adapter port declarations (D13, docs/adapters.md §1.2).
 *
 * These are hand-maintained .d.ts for adapter authors; the runtime contract is
 * the same shapes in JSDoc. Core NEVER imports adapters — adapters implement
 * ports, core consumes them via the host plugin wrapper only.
 *
 * Capability tiers (runtime-detected via `capabilities()`, never hardcoded):
 *  - Tier 2: dispatch='native'   — host exposes session APIs (e.g. ZCode session tools)
 *  - Tier 1: dispatch='cli'      — host has a CLI/headless mode (spawn + resume)
 *  - Tier 0: dispatch=null       — observe-only; core degrades to register/track/alert
 */

export type DispatchMode = 'native' | 'cli' | null;
export type SurfaceMode = 'panel' | null;

export interface CapabilitySet {
  dispatch: DispatchMode;
  observe: boolean;
  surface: SurfaceMode;
}

/** Reference to a host-side task session. Opaque to core — adapters own its shape. */
export interface SessionRef {
  readonly host: string;
  /** Tier 2: host session id; Tier 1: process/task record id; Tier 0: never created. */
  readonly sessionId: string;
  readonly workspace?: string;
}

export interface DispatchSpec {
  title: string;
  /** Full instruction injected into the task session. */
  prompt: string;
  workspace?: string;
  project?: string;
}

export interface Ack {
  ok: boolean;
  message?: string;
}

export interface WaitResult {
  /** SessionRefs that satisfied the wait condition. */
  settled: SessionRef[];
  timedOut: boolean;
}

export type HostEventKind =
  | 'session_started'
  | 'activity'
  | 'waiting_on_user'
  | 'blocked'
  | 'stopped'
  | 'failed';

export interface HostEvent {
  kind: HostEventKind;
  ref: SessionRef;
  ts: number;
  detail?: string;
}

export interface DispatchPort {
  create(spec: DispatchSpec): Promise<SessionRef>;
  send(ref: SessionRef, message: string): Promise<Ack>;
  wait(refs: SessionRef[], mode: 'any' | 'all', timeoutMs: number): Promise<WaitResult>;
  interrupt(ref: SessionRef): Promise<Ack>;
  /** Optional capability — implement only if the host can return session context. */
  readContext?(ref: SessionRef): Promise<string>;
}

export interface ObservePort {
  /** Push-based; returns an unsubscribe function. */
  subscribe(handler: (event: HostEvent) => void): () => void;
}

/** Outbound alert channel — orthogonal family to HostAdapter (feishu/slack/telegram). */
export interface Alert {
  taskId: number;
  displayId: string;
  title: string;
  status: 'waiting_decision' | 'blocked' | 'review';
  summary: string;
  /** What the user should do next, rendered for the channel. */
  ask: string;
}

export interface NotifyPort {
  send(alert: Alert): Promise<Ack>;
}

export interface HostAdapter {
  readonly id: string;
  capabilities(): CapabilitySet;
  dispatch?: DispatchPort;
  observe?: ObservePort;
}

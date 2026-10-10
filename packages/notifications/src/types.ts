/**
 * @ai-factory/notifications — types (spec module 30: Notification Engine).
 *
 * A Notification is the durable record of something the system wants the
 * human to know. Delivery is tracked separately: every emitted notification
 * gets one in-app DeliveryRecord (channel 'in_app'). Other channels (email,
 * webhook) can be added without touching the rule engine.
 */

/** Machine-readable event the engine reacts to. */
export type NotificationEventType =
  | 'TASK_BLOCKED'
  | 'GATE_FAILED'
  | 'DEPLOYMENT_COMPLETED'
  | 'DEPLOYMENT_FAILED'
  | 'APPROVAL_PENDING'
  | 'APPROVAL_DECIDED'
  | 'BUILD_FAILED'
  | 'TASK_COMPLETED'
  | 'GENERIC';

/** Notification priority (drives the UI badge + ordering). */
export type NotificationPriority = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

/** Incoming event that feeds the rule engine. */
export interface NotificationEvent {
  type: NotificationEventType;
  /** Related domain entity, e.g. { kind: 'task', id, label }. */
  entity?: { kind: string; id: string; label?: string };
  /** Free-form detail the rules/templates can interpolate. */
  detail?: Record<string, unknown>;
  /** Who/what raised the event; defaults to 'system'. */
  actor?: string;
  /** Epoch ms; defaults to clock.now(). */
  at?: number;
}

/** A produced notification record. */
export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  priority: NotificationPriority;
  entity?: { kind: string; id: string; label?: string };
  actor: string;
  read: boolean;
  createdAt: string;
  readAt: string | null;
}

/** Delivery record for a notification over one channel (prototype: in-app). */
export interface DeliveryRecord {
  id: string;
  notificationId: string;
  channel: 'in_app';
  status: 'delivered' | 'failed';
  deliveredAt: string;
  error?: string;
}

/** Rule outcome: what notification to build for a matched event. */
export interface RuleOutcome {
  title: string;
  body: string;
  priority: NotificationPriority;
  /** Optional override of the emitted notification type label. */
  type?: string;
}

/** A single rule: predicate over the event + the outcome to produce. */
export interface NotificationRule {
  id: string;
  eventTypes: NotificationEventType[];
  /** Additional guard; all rules with a truthy `when` for the event fire. */
  when?: (event: NotificationEvent) => boolean;
  build: (event: NotificationEvent) => RuleOutcome;
}

export interface Clock {
  now(): number;
}

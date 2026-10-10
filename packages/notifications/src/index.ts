/**
 * @ai-factory/notifications — rule-driven in-app notifications (spec module 30).
 *
 *   rules   event type → conditions → notification (priority + template)
 *   engine  NotificationEngine: emit/list/markRead/markAllRead + deliveries
 *   types   NotificationEvent, Notification, DeliveryRecord, NotificationRule
 */
export * from './types';
export * from './rules';
export * from './engine';

/**
 * Notification routes — spec module 30 (Notification Engine).
 *
 *   GET  /api/notifications               list (newest first) + unread count
 *   POST /api/notifications/:id/read      mark one read
 *   POST /api/notifications/read-all      mark all read
 *
 * Notifications are produced by the rule engine (NotificationEngine.emit)
 * at key system actions: task BLOCKED transitions (index.ts), gate failures
 * (review.ts), deployment completion (cicd.ts), approval requests
 * (approvals.ts). PROTOTYPE NOTE: engine is in-memory (lost on restart).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext } from './context';

const PREFIX = '/api/notifications';

export async function handleNotificationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // POST /api/notifications/read-all — must come before the :id matcher.
  if (method === 'POST' && path === `${PREFIX}/read-all`) {
    const marked = ctx.notify.markAllRead();
    ctx.audit.record('human', 'NOTIFICATIONS_READ_ALL', 'notification', 'all', { marked });
    return ctx.json(res, 200, { marked, unread: ctx.notify.unreadCount() }), true;
  }

  // GET /api/notifications
  if (method === 'GET' && path === PREFIX) {
    return ctx.json(res, 200, {
      notifications: ctx.notify.list(),
      unread: ctx.notify.unreadCount(),
    }), true;
  }

  // POST /api/notifications/:id/read
  const readMatch = path.match(new RegExp(`^${PREFIX.replace(/\//g, '\\/')}/([^/]+)/read$`));
  if (method === 'POST' && readMatch) {
    const n = ctx.notify.markRead(decodeURIComponent(readMatch[1]));
    if (!n) return ctx.json(res, 404, { error: 'notification not found' }), true;
    return ctx.json(res, 200, { notification: n, unread: ctx.notify.unreadCount() }), true;
  }

  return false;
}

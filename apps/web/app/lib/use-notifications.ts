'use client'

import { notificationListResponseSchema, type NotificationListResponse } from '@bookswap/shared'
import { apiRequest } from './api'
import { announceResourceChanged, useReloadOnResourceChange } from './resource-sync'
import { useApiResource, type Resource } from './use-resource'

/**
 * §8: `GET /me/notifications?unread=true`.
 *
 * `unreadCount` приходить окремо від списку й **не** виводиться з його довжини:
 * лічильник має однаково працювати на обох вкладках, а на вкладці «усі» довжина
 * списку відповідала б на інше питання.
 */
export type NotificationsResource = Resource<NotificationListResponse>

export function useNotifications(unreadOnly: boolean): NotificationsResource {
  const resource = useApiResource(
    `/me/notifications${unreadOnly ? '?unread=true' : ''}`,
    notificationListResponseSchema,
  )

  // The navbar badge and the notifications page are separate instances: a notification marked
  // read in one must update the other's list and `unreadCount`.
  useReloadOnResourceChange('notifications', resource.reload)

  return resource
}

/** §8: `PATCH /me/notifications/:id/read`. */
export function markNotificationRead(notificationId: string): Promise<void> {
  return changeNotifications(() =>
    apiRequest(`/me/notifications/${notificationId}/read`, { method: 'PATCH' }),
  )
}

/** §8: `POST /me/notifications/read-all` — marks, never deletes: the «all» list keeps the history. */
export function markAllNotificationsRead(): Promise<void> {
  return changeNotifications(() => apiRequest('/me/notifications/read-all', { method: 'POST' }))
}

/**
 * Every notification mutation of the navbar panel and `/notifications` goes through here, so the
 * other mounted reader — the badge on the notifications page, the page behind the open panel —
 * cannot be left showing the old list and `unreadCount`.
 */
async function changeNotifications(request: () => Promise<unknown>): Promise<void> {
  await request()
  announceResourceChanged('notifications')
}

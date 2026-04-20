/**
 * PushService — out-of-session delivery via Expo Push API.
 *
 * Handles iOS + Android + web. Batch-sends to all active DeviceToken rows for
 * a user. Marks tokens invalid when Expo reports DeviceNotRegistered so we
 * don't send to dead installs.
 *
 * ResponseOrchestrator decides WHEN to use push; this service just delivers.
 */
import { Expo, type ExpoPushMessage, type ExpoPushTicket, type ExpoPushErrorReceipt } from 'expo-server-sdk';
import { prisma } from '../../index';

const expo = new Expo({
  // accessToken optional; required only if using FCM v1 or iOS-specific features
  accessToken: process.env.EXPO_ACCESS_TOKEN,
});

export type PushCategory =
  | 'reminder'      // commitment due, you said you'd...
  | 'pre_brief'     // upcoming meeting context
  | 'insight'       // pattern noticed
  | 'social'        // someone mentioned you / followed up
  | 'urgent'        // watched condition fired
  | 'digest';       // morning/evening/weekly

export interface PushPayload {
  userId: string;
  title: string;
  body: string;
  category: PushCategory;
  data?: Record<string, unknown>; // deep-link data, whisperId, briefId, etc.
  importance?: number; // 1-10; >7 uses time-critical iOS delivery
  sound?: boolean;     // default true
}

export class PushService {
  /** Send a push to all of a user's active device tokens. */
  async send(payload: PushPayload): Promise<{ sent: number; invalid: number }> {
    const devices = await prisma.deviceToken.findMany({
      where: { userId: payload.userId, status: 'active' },
    });
    if (devices.length === 0) return { sent: 0, invalid: 0 };

    const messages: ExpoPushMessage[] = [];
    for (const d of devices) {
      if (!Expo.isExpoPushToken(d.token)) {
        // Not an Expo-flavored token (probably raw APNS/FCM) — mark invalid
        await prisma.deviceToken.update({ where: { id: d.id }, data: { status: 'invalid' } }).catch(() => {});
        continue;
      }
      messages.push({
        to: d.token,
        title: payload.title,
        body: payload.body,
        data: { category: payload.category, ...(payload.data || {}) },
        sound: payload.sound === false ? undefined : 'default',
        priority: (payload.importance ?? 5) >= 7 ? 'high' : 'default',
        categoryId: payload.category,
        channelId: payload.category, // Android notification channels
      });
    }

    if (messages.length === 0) return { sent: 0, invalid: devices.length };

    // Batch into chunks (Expo limits ~100/message per call)
    const chunks = expo.chunkPushNotifications(messages);
    const tickets: ExpoPushTicket[] = [];
    for (const chunk of chunks) {
      try {
        const res = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...res);
      } catch (err: any) {
        console.error('[push] chunk send failed:', err?.message);
      }
    }

    let sent = 0, invalid = 0;
    // Map tickets back to messages (same order)
    for (let i = 0; i < tickets.length; i++) {
      const t = tickets[i];
      const token = messages[i]?.to as string | undefined;
      if (t.status === 'ok') {
        sent++;
      } else {
        const err = (t as ExpoPushErrorReceipt).details?.error;
        if (err === 'DeviceNotRegistered' || err === 'InvalidCredentials') {
          invalid++;
          if (token) {
            await prisma.deviceToken.updateMany({
              where: { userId: payload.userId, token },
              data: { status: 'invalid' },
            }).catch(() => {});
          }
        }
        console.warn(`[push] ticket error: ${err || 'unknown'}`);
      }
    }
    return { sent, invalid };
  }

  async registerDevice(params: {
    userId: string;
    token: string;
    platform: 'ios' | 'android' | 'web';
    deviceName?: string;
    appVersion?: string;
  }): Promise<string> {
    const existing = await prisma.deviceToken.findUnique({ where: { token: params.token } });
    if (existing) {
      await prisma.deviceToken.update({
        where: { id: existing.id },
        data: {
          userId: params.userId,
          platform: params.platform,
          deviceName: params.deviceName,
          appVersion: params.appVersion,
          status: 'active',
          lastUsedAt: new Date(),
        },
      });
      return existing.id;
    }
    const row = await prisma.deviceToken.create({
      data: {
        userId: params.userId,
        token: params.token,
        platform: params.platform,
        deviceName: params.deviceName,
        appVersion: params.appVersion,
      },
    });
    return row.id;
  }

  async unregisterDevice(userId: string, token: string): Promise<void> {
    await prisma.deviceToken.updateMany({
      where: { userId, token },
      data: { status: 'revoked' },
    });
  }
}

export const pushService = new PushService();

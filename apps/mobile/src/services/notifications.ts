/**
 * Push notification setup — Expo Notifications wrapper.
 *
 * Registers the device with the server on mount. Configures foreground
 * behavior (we DON'T pop alerts while the app is visible — the in-session
 * whisper UI is the right surface). Sets up deep-link handling so tapping
 * a push takes the user to the relevant memory item.
 */
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { api } from './api';

// When app is foregrounded, don't pop an OS banner — the in-session whisper
// pipeline is the right surface.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: false,
    shouldPlaySound: false,
    shouldSetBadge: true,
    shouldShowBanner: false,
    shouldShowList: true,
  }),
});

let registeredToken: string | null = null;

/**
 * Ask for permission, get Expo push token, register with server.
 * Safe to call multiple times — server dedupes by token.
 */
export async function setupPushNotifications(): Promise<string | null> {
  if (!Device.isDevice) {
    // Simulator won't get tokens
    return null;
  }

  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (existing !== 'granted') {
      const res = await Notifications.requestPermissionsAsync();
      status = res.status;
    }
    if (status !== 'granted') {
      console.log('[push] permission denied by user');
      return null;
    }

    // Android: categories become channels
    if (Platform.OS === 'android') {
      for (const id of ['reminder', 'pre_brief', 'insight', 'social', 'urgent', 'digest']) {
        await Notifications.setNotificationChannelAsync(id, {
          name: id.replace('_', ' '),
          importance:
            id === 'urgent' ? Notifications.AndroidImportance.MAX
            : id === 'reminder' ? Notifications.AndroidImportance.HIGH
            : Notifications.AndroidImportance.DEFAULT,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#7c7fff',
        });
      }
    }

    // Get the Expo push token (works with dev client + standalone)
    const projectId = require('../../app.json')?.expo?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    const token = tokenData.data;

    if (registeredToken === token) return token; // already registered this session

    await api.post('devices/register', {
      token,
      platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
      deviceName: Device.deviceName || undefined,
      appVersion: require('../../app.json')?.expo?.version || undefined,
    });
    registeredToken = token;
    console.log('[push] registered token', token.slice(0, 20) + '...');
    return token;
  } catch (err: any) {
    console.warn('[push] setup failed:', err?.message);
    return null;
  }
}

export async function disableNotifications(): Promise<void> {
  if (!registeredToken) return;
  try {
    await api.delete(`devices/${encodeURIComponent(registeredToken)}`);
  } catch {}
  registeredToken = null;
}

/**
 * Tap handler — called when user taps a notification that opened the app.
 * Navigates to the relevant screen based on notification.data.category.
 */
export type NotificationTapHandler = (data: Record<string, unknown>) => void;

export function subscribeToNotificationTaps(handler: NotificationTapHandler) {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    try {
      const data = response.notification.request.content.data;
      handler((data || {}) as Record<string, unknown>);
    } catch (err: any) {
      console.warn('[push] tap handler error:', err?.message);
    }
  });
}

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { api } from '../api/client';

const PREFS_KEY = 'probid_notification_prefs';
const TOKEN_KEY = 'probid_push_token';

export interface NotificationPreferences {
  estimateReady: boolean;
  trialExpiring: boolean;
  failedPayment: boolean;
}

const DEFAULT_PREFS: NotificationPreferences = {
  estimateReady: true,
  trialExpiring: true,
  failedPayment: true,
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function getNotificationPreferences(): Promise<NotificationPreferences> {
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export async function setNotificationPreferences(prefs: NotificationPreferences): Promise<void> {
  await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  if (token) {
    try {
      await api.registerPushToken(token, prefs);
    } catch {}
  }
}

export async function registerForPushNotifications(): Promise<string | null> {
  if (!Device.isDevice) {
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    return null;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
    });
  }

  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: projectId ?? undefined,
    });
    const token = tokenData.data;

    await AsyncStorage.setItem(TOKEN_KEY, token);

    const prefs = await getNotificationPreferences();
    try {
      await api.registerPushToken(token, prefs);
    } catch {}

    return token;
  } catch {
    return null;
  }
}

export async function refreshPushToken(): Promise<void> {
  await registerForPushNotifications();
}

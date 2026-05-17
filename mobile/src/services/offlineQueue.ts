import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../api/client';
import { Alert } from 'react-native';

const QUEUE_KEY = 'probid_offline_queue';

export interface QueuedEstimate {
  id: string;
  jobType: string;
  market: string;
  tradePreset?: string;
  details?: string;
  imageUris: string[];
  queuedAt: number;
}

export async function getQueue(): Promise<QueuedEstimate[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as QueuedEstimate[];
  } catch {
    return [];
  }
}

async function saveQueue(queue: QueuedEstimate[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export async function enqueueEstimate(data: Omit<QueuedEstimate, 'id' | 'queuedAt'>): Promise<void> {
  const queue = await getQueue();
  const item: QueuedEstimate = {
    ...data,
    id: `offline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    queuedAt: Date.now(),
  };
  queue.push(item);
  await saveQueue(queue);
}

let processing = false;

export async function processQueue(): Promise<{ succeeded: number; failed: number }> {
  if (processing) return { succeeded: 0, failed: 0 };
  processing = true;
  try {
    return await _processQueue();
  } finally {
    processing = false;
  }
}

async function _processQueue(): Promise<{ succeeded: number; failed: number }> {
  const queue = await getQueue();
  if (queue.length === 0) return { succeeded: 0, failed: 0 };

  let succeeded = 0;
  let failed = 0;
  const remaining: QueuedEstimate[] = [];

  for (const item of queue) {
    try {
      const formData = new FormData();
      formData.append('jobType', item.jobType);
      formData.append('market', item.market);
      if (item.tradePreset) formData.append('tradePreset', item.tradePreset);
      if (item.details) formData.append('details', item.details);

      for (let i = 0; i < item.imageUris.length; i++) {
        const uri = item.imageUris[i];
        const ext = uri.split('.').pop()?.toLowerCase() || 'jpg';
        const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
        formData.append('photos', {
          uri,
          name: `photo_${i}.${ext}`,
          type: mimeType,
        } as any);
      }

      await api.createEstimate(formData);
      succeeded++;
    } catch {
      remaining.push(item);
      failed++;
    }
  }

  await saveQueue(remaining);

  if (succeeded > 0) {
    Alert.alert(
      'Offline Estimates Submitted',
      `${succeeded} queued estimate${succeeded !== 1 ? 's' : ''} ${succeeded !== 1 ? 'have' : 'has'} been submitted successfully.`,
    );
  }

  return { succeeded, failed };
}

export async function getQueueCount(): Promise<number> {
  const queue = await getQueue();
  return queue.length;
}

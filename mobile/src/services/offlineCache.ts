import AsyncStorage from '@react-native-async-storage/async-storage';
import { Estimate } from '../api/client';

const CACHE_KEY = 'probid_cached_estimates';
const MAX_CACHED = 20;

export async function cacheEstimates(estimates: Estimate[]): Promise<void> {
  try {
    const toCache = estimates.slice(0, MAX_CACHED);
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(toCache));
  } catch {}
}

export async function getCachedEstimates(): Promise<Estimate[]> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Estimate[];
  } catch {
    return [];
  }
}

export async function clearCachedEstimates(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CACHE_KEY);
  } catch {}
}

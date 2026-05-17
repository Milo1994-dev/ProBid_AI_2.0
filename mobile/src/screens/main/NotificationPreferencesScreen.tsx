import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  ActivityIndicator,
} from 'react-native';
import { colors } from '../../theme/colors';
import {
  getNotificationPreferences,
  setNotificationPreferences,
  NotificationPreferences,
} from '../../services/notifications';

export default function NotificationPreferencesScreen() {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getNotificationPreferences().then((p) => {
      setPrefs(p);
      setLoading(false);
    });
  }, []);

  const togglePref = async (key: keyof NotificationPreferences) => {
    if (!prefs) return;
    const updated = { ...prefs, [key]: !prefs[key] };
    setPrefs(updated);
    await setNotificationPreferences(updated);
  };

  if (loading || !prefs) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.green} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title}>Notification Preferences</Text>
      <Text style={styles.subtitle}>
        Choose which notifications you'd like to receive.
      </Text>

      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowInfo}>
            <Text style={styles.rowTitle}>Estimate Ready</Text>
            <Text style={styles.rowDesc}>
              Get notified when your estimate is generated.
            </Text>
          </View>
          <Switch
            value={prefs.estimateReady}
            onValueChange={() => togglePref('estimateReady')}
            trackColor={{ false: colors.border, true: 'rgba(0, 230, 118, 0.4)' }}
            thumbColor={prefs.estimateReady ? colors.green : colors.textSubtle}
          />
        </View>

        <View style={styles.divider} />

        <View style={styles.row}>
          <View style={styles.rowInfo}>
            <Text style={styles.rowTitle}>Trial Expiring</Text>
            <Text style={styles.rowDesc}>
              Reminder 1 day before your trial ends.
            </Text>
          </View>
          <Switch
            value={prefs.trialExpiring}
            onValueChange={() => togglePref('trialExpiring')}
            trackColor={{ false: colors.border, true: 'rgba(0, 230, 118, 0.4)' }}
            thumbColor={prefs.trialExpiring ? colors.green : colors.textSubtle}
          />
        </View>

        <View style={styles.divider} />

        <View style={styles.row}>
          <View style={styles.rowInfo}>
            <Text style={styles.rowTitle}>Failed Payment</Text>
            <Text style={styles.rowDesc}>
              Alert when a payment fails and needs attention.
            </Text>
          </View>
          <Switch
            value={prefs.failedPayment}
            onValueChange={() => togglePref('failedPayment')}
            trackColor={{ false: colors.border, true: 'rgba(0, 230, 118, 0.4)' }}
            thumbColor={prefs.failedPayment ? colors.green : colors.textSubtle}
          />
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 4,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 14,
    marginBottom: 24,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  rowInfo: {
    flex: 1,
  },
  rowTitle: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  rowDesc: {
    color: colors.textSubtle,
    fontSize: 13,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: 16,
  },
});

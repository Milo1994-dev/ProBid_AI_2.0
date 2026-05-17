import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { colors } from '../../theme/colors';
import { useAuth } from '../../contexts/AuthContext';
import { useNetwork } from '../../contexts/NetworkContext';
import { api, Estimate, BillingStatus, UsageData } from '../../api/client';
import { cacheEstimates, getCachedEstimates } from '../../services/offlineCache';
import type { DashboardScreenProps } from '../../navigation/types';

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function DashboardScreen({ navigation }: DashboardScreenProps) {
  const { user } = useAuth();
  const { isConnected } = useNetwork();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  const [totalEstimates, setTotalEstimates] = useState(0);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [isOfflineData, setIsOfflineData] = useState(false);

  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    if (!isConnected) {
      const cached = await getCachedEstimates();
      setEstimates(cached.slice(0, 5));
      setTotalEstimates(cached.length);
      setIsOfflineData(cached.length > 0);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    try {
      setError('');
      const [usageRes, estimatesRes, billingRes] = await Promise.all([
        api.getUsage(),
        api.getEstimates(1),
        api.getBillingStatus(),
      ]);
      if (usageRes.data) setUsage(usageRes.data);
      if (estimatesRes.data) {
        setEstimates(estimatesRes.data.estimates.slice(0, 5));
        setTotalEstimates(estimatesRes.data.total);
        cacheEstimates(estimatesRes.data.estimates);
      }
      if (billingRes.data) setBilling(billingRes.data);
      setIsOfflineData(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load dashboard data.';
      setError(message);
      const cached = await getCachedEstimates();
      if (cached.length > 0) {
        setEstimates(cached.slice(0, 5));
        setTotalEstimates(cached.length);
        setIsOfflineData(true);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isConnected]);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData]),
  );

  const onRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const isFree = billing?.plan === 'free';
  const usedCount = usage?.used ?? 0;
  const limitCount = usage?.limit ?? 2;

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.green} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.green}
        />
      }>
      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{error}</Text>
          <TouchableOpacity onPress={onRefresh}>
            <Text style={styles.errorRetryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Dashboard</Text>
          <Text style={styles.email}>{user?.email}</Text>
        </View>
        <TouchableOpacity
          style={styles.newButton}
          onPress={() => navigation.navigate('NewEstimate')}>
          <Text style={styles.newButtonText}>+ New Estimate</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statIcon}>📊</Text>
          <Text style={styles.statValue}>
            {usage?.isUnlimited
              ? '∞'
              : `${usedCount} / ${limitCount}`}
          </Text>
          <Text style={styles.statLabel}>Estimates Used</Text>
        </View>
        <View style={[styles.statCard, billing?.plan !== 'free' && styles.statCardHighlight]}>
          <Text style={styles.statIcon}>💳</Text>
          <Text style={styles.statValue}>
            {(billing?.plan ?? 'free').charAt(0).toUpperCase() +
              (billing?.plan ?? 'free').slice(1)}
          </Text>
          <Text style={styles.statLabel}>Current Plan</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statIcon}>📋</Text>
          <Text style={styles.statValue}>{totalEstimates}</Text>
          <Text style={styles.statLabel}>Total</Text>
        </View>
      </View>

      {isFree && (
        <View style={styles.upgradeCard}>
          <View style={styles.upgradeContent}>
            <Text style={styles.upgradeTitle}>
              {usage?.isUnlimited
                ? 'Unlimited estimates'
                : limitCount > 0
                  ? `${usedCount} / ${limitCount} free estimates used`
                  : 'Subscribe to start estimating'}
            </Text>
            {!usage?.isUnlimited && limitCount > 0 && (
              <View style={styles.progressBar}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${Math.min(100, Math.round((usedCount / limitCount) * 100))}%`,
                    },
                    usedCount >= limitCount && styles.progressFillFull,
                  ]}
                />
              </View>
            )}
            <Text style={styles.upgradeSubtitle}>
              Start your 7-day free trial for unlimited estimates.
            </Text>
          </View>
          <TouchableOpacity
            style={styles.upgradeButton}
            onPress={() => navigation.navigate('Billing')}>
            <Text style={styles.upgradeButtonText}>Upgrade</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.quickActions}>
        {[
          { label: 'New Estimate', icon: '⚡', target: () => navigation.navigate('NewEstimate') },
          { label: 'Templates', icon: '📋', target: () => navigation.navigate('NewEstimate', { openTemplates: true }) },
          { label: 'History', icon: '📜', target: () => navigation.navigate('Tabs', { screen: 'History' }) },
          { label: 'Billing', icon: '💳', target: () => navigation.navigate('Billing') },
        ].map((action) => (
          <TouchableOpacity
            key={action.label}
            style={styles.actionCard}
            onPress={action.target}>
            <Text style={styles.actionIcon}>{action.icon}</Text>
            <Text style={styles.actionLabel}>{action.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.recentSection}>
        <View style={styles.recentHeader}>
          <Text style={styles.sectionTitle}>Recent Estimates</Text>
          <TouchableOpacity onPress={() => navigation.navigate('Tabs', { screen: 'History' })}>
            <Text style={styles.viewAllLink}>View all</Text>
          </TouchableOpacity>
        </View>

        {estimates.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyIcon}>📋</Text>
            <Text style={styles.emptyTitle}>No estimates yet</Text>
            <Text style={styles.emptySubtitle}>
              Create your first estimate to see it here.
            </Text>
            <TouchableOpacity
              style={styles.emptyButton}
              onPress={() => navigation.navigate('NewEstimate')}>
              <Text style={styles.emptyButtonText}>Create Estimate</Text>
            </TouchableOpacity>
          </View>
        ) : (
          estimates.map((est) => (
            <TouchableOpacity
              key={est.id}
              style={styles.estimateCard}
              onPress={() =>
                navigation.navigate('EstimateDetail', { id: est.id })
              }>
              <View style={styles.estimateInfo}>
                <Text style={styles.estimateType} numberOfLines={1}>
                  {est.jobType}
                </Text>
                <Text style={styles.estimateMeta}>
                  {formatDate(est.createdAt)} · {est.market}
                </Text>
              </View>
              <View style={styles.viewBadge}>
                <Text style={styles.viewBadgeText}>View</Text>
              </View>
            </TouchableOpacity>
          ))
        )}
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 28,
    fontWeight: '900',
  },
  email: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  newButton: {
    backgroundColor: colors.green,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  newButtonText: {
    color: colors.bg,
    fontWeight: '700',
    fontSize: 14,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    alignItems: 'center',
  },
  statCardHighlight: {
    borderColor: 'rgba(0, 230, 118, 0.3)',
  },
  statIcon: {
    fontSize: 20,
    marginBottom: 6,
  },
  statValue: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '800',
  },
  statLabel: {
    color: colors.textSubtle,
    fontSize: 11,
    marginTop: 2,
  },
  upgradeCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(92, 107, 192, 0.3)',
    padding: 16,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  upgradeContent: {
    flex: 1,
  },
  upgradeTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  progressBar: {
    height: 6,
    backgroundColor: colors.border,
    borderRadius: 3,
    marginBottom: 8,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.indigo,
    borderRadius: 3,
  },
  progressFillFull: {
    backgroundColor: colors.red,
  },
  upgradeSubtitle: {
    color: colors.textSubtle,
    fontSize: 12,
  },
  upgradeButton: {
    backgroundColor: colors.green,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  upgradeButtonText: {
    color: colors.bg,
    fontWeight: '700',
    fontSize: 13,
  },
  quickActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 24,
  },
  actionCard: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 16,
    alignItems: 'center',
    gap: 6,
  },
  actionIcon: {
    fontSize: 24,
  },
  actionLabel: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '500',
  },
  recentSection: {},
  recentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
  viewAllLink: {
    color: colors.green,
    fontSize: 14,
  },
  estimateCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  estimateInfo: {
    flex: 1,
  },
  estimateType: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  estimateMeta: {
    color: colors.textSubtle,
    fontSize: 12,
    marginTop: 2,
  },
  viewBadge: {
    backgroundColor: 'rgba(92, 107, 192, 0.15)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  viewBadgeText: {
    color: colors.indigo,
    fontSize: 12,
    fontWeight: '600',
  },
  emptyCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 32,
    alignItems: 'center',
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  emptyTitle: {
    color: colors.textMuted,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  emptySubtitle: {
    color: colors.textSubtle,
    fontSize: 14,
    marginBottom: 16,
    textAlign: 'center',
  },
  emptyButton: {
    backgroundColor: colors.green,
    borderRadius: 10,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  emptyButtonText: {
    color: colors.bg,
    fontWeight: '700',
    fontSize: 14,
  },
  errorBanner: {
    backgroundColor: '#3a1c1c',
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  errorBannerText: {
    color: '#ff6b6b',
    fontSize: 14,
    flex: 1,
    marginRight: 12,
  },
  errorRetryText: {
    color: colors.green,
    fontWeight: '700',
    fontSize: 14,
  },
});

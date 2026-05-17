import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { colors } from '../../theme/colors';
import { api, BillingStatus, ApiError, API_BASE_URL } from '../../api/client';
import type { BillingScreenProps } from '../../navigation/types';

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function planLabel(plan: string): string {
  const labels: Record<string, string> = {
    free: 'Free',
    pro: 'Pro',
    business: 'Business',
    lifetime: 'Lifetime',
  };
  return labels[plan] ?? plan;
}

export default function BillingScreen(_props: BillingScreenProps) {
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'annual'>(
    'monthly',
  );

  useEffect(() => {
    loadBilling();
  }, []);

  const loadBilling = async () => {
    try {
      setError('');
      const res = await api.getBillingStatus();
      if (res.data) setBilling(res.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load billing information.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleUpgrade = async (plan: 'pro' | 'business') => {
    setError('');
    setCheckoutLoading(plan);
    try {
      const res = await api.createCheckoutSession(plan, billingInterval);
      if (res.data?.url) {
        await WebBrowser.openBrowserAsync(res.data.url);
        loadBilling();
      } else {
        setError('Failed to start checkout.');
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        const apiErr = err as ApiError;
        setError(apiErr.apiError ?? apiErr.message ?? 'Failed to start checkout.');
      } else {
        setError('Failed to start checkout.');
      }
    } finally {
      setCheckoutLoading(null);
    }
  };

  const handleManage = async () => {
    await WebBrowser.openBrowserAsync(
      `${API_BASE_URL}/billing/portal`,
    );
    loadBilling();
  };

  const isPaid = billing?.plan && billing.plan !== 'free';

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.green} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title}>Billing</Text>
      <Text style={styles.subtitle}>Manage your subscription and billing.</Text>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.planCard}>
        <Text style={styles.sectionTitle}>Current Plan</Text>
        <View style={styles.planRow}>
          <View>
            <View style={styles.planBadgeRow}>
              <Text style={styles.planName}>
                {planLabel(billing?.plan ?? 'free')}
              </Text>
              <View
                style={[
                  styles.statusBadge,
                  isPaid ? styles.statusBadgeActive : styles.statusBadgeFree,
                ]}>
                <Text
                  style={[
                    styles.statusBadgeText,
                    isPaid ? styles.statusActive : styles.statusFree,
                  ]}>
                  {billing?.status === 'active'
                    ? 'Active'
                    : billing?.status ?? 'Free'}
                </Text>
              </View>
            </View>
            {billing?.currentPeriodEnd && (
              <Text style={styles.renewsText}>
                Renews {formatDate(billing.currentPeriodEnd)}
              </Text>
            )}
            {!isPaid && (
              <Text style={styles.freeNote}>
                7-day free trial — no charge during trial
              </Text>
            )}
          </View>
          {isPaid && (
            <TouchableOpacity style={styles.manageButton} onPress={handleManage}>
              <Text style={styles.manageButtonText}>Manage</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {!isPaid && (
        <>
          <View style={styles.toggleRow}>
            <Text style={styles.sectionTitle}>Upgrade Your Plan</Text>
            <View style={styles.intervalToggle}>
              <TouchableOpacity
                style={[
                  styles.intervalOption,
                  billingInterval === 'monthly' && styles.intervalOptionActive,
                ]}
                onPress={() => setBillingInterval('monthly')}>
                <Text
                  style={[
                    styles.intervalText,
                    billingInterval === 'monthly' && styles.intervalTextActive,
                  ]}>
                  Monthly
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.intervalOption,
                  billingInterval === 'annual' && styles.intervalOptionActive,
                ]}
                onPress={() => setBillingInterval('annual')}>
                <Text
                  style={[
                    styles.intervalText,
                    billingInterval === 'annual' && styles.intervalTextActive,
                  ]}>
                  Annual
                </Text>
                <View style={styles.saveBadge}>
                  <Text style={styles.saveBadgeText}>Save 20%</Text>
                </View>
              </TouchableOpacity>
            </View>
          </View>

          <View style={[styles.planCard, styles.proCard]}>
            <View style={styles.trialBadge}>
              <Text style={styles.trialBadgeText}>7-Day Free Trial</Text>
            </View>
            <View style={styles.planHeader}>
              <Text style={styles.planHeaderTitle}>Pro</Text>
              <View style={styles.priceBadge}>
                <Text style={styles.priceBadgeText}>
                  {billingInterval === 'annual' ? '$240/yr' : '$25/mo'}
                </Text>
              </View>
              {billingInterval === 'annual' && (
                <Text style={styles.saveText}>Save $60</Text>
              )}
            </View>
            {billingInterval === 'annual' && (
              <Text style={styles.perMonth}>$20/mo billed annually</Text>
            )}
            <View style={styles.features}>
              {[
                'Unlimited estimates',
                'Photo analysis',
                'Saved history & PDF export',
                'Priority support',
              ].map((f) => (
                <Text key={f} style={styles.feature}>
                  ✓ {f}
                </Text>
              ))}
            </View>
            <Text style={styles.trialNote}>
              Try free for 7 days — no charge until after trial
            </Text>
            <TouchableOpacity
              style={styles.upgradeButton}
              onPress={() => handleUpgrade('pro')}
              disabled={!!checkoutLoading}>
              {checkoutLoading === 'pro' ? (
                <ActivityIndicator color={colors.bg} />
              ) : (
                <Text style={styles.upgradeButtonText}>
                  Start 7-Day Free Trial
                </Text>
              )}
            </TouchableOpacity>
          </View>

          <View style={styles.planCard}>
            <View style={[styles.trialBadge, styles.trialBadgeBiz]}>
              <Text style={[styles.trialBadgeText, styles.trialBadgeTextBiz]}>
                7-Day Free Trial
              </Text>
            </View>
            <View style={styles.planHeader}>
              <Text style={styles.planHeaderTitle}>Business</Text>
              <View style={[styles.priceBadge, styles.priceBadgeGreen]}>
                <Text style={styles.priceBadgeText}>
                  {billingInterval === 'annual' ? '$948/yr' : '$55/mo'}
                </Text>
              </View>
            </View>
            {billingInterval === 'annual' && (
              <Text style={styles.perMonth}>$79/mo billed annually</Text>
            )}
            <View style={styles.features}>
              {[
                'Everything in Pro',
                'Team collaboration',
                'Custom branding',
                'Analytics dashboard',
              ].map((f) => (
                <Text key={f} style={styles.feature}>
                  ✓ {f}
                </Text>
              ))}
            </View>
            <Text style={styles.trialNote}>
              Try free for 7 days — no charge until after trial
            </Text>
            <TouchableOpacity
              style={[styles.upgradeButton, styles.upgradeButtonSecondary]}
              onPress={() => handleUpgrade('business')}
              disabled={!!checkoutLoading}>
              {checkoutLoading === 'business' ? (
                <ActivityIndicator color={colors.textPrimary} />
              ) : (
                <Text style={styles.upgradeButtonSecondaryText}>
                  Start 7-Day Free Trial
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </>
      )}

      {isPaid && (
        <View style={styles.paidCard}>
          <Text style={styles.paidText}>
            You're on the {planLabel(billing?.plan ?? '')} plan. Enjoy unlimited
            estimates!
          </Text>
          <TouchableOpacity style={styles.manageButton} onPress={handleManage}>
            <Text style={styles.manageButtonText}>
              Manage Subscription & Invoices
            </Text>
          </TouchableOpacity>
        </View>
      )}
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
    fontSize: 28,
    fontWeight: '900',
    marginBottom: 4,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 14,
    marginBottom: 24,
  },
  errorBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  errorText: {
    color: colors.red,
    fontSize: 14,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  planCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    marginBottom: 16,
    overflow: 'hidden',
  },
  proCard: {
    borderColor: 'rgba(92, 107, 192, 0.4)',
  },
  planRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  planBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  planName: {
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: '900',
    textTransform: 'capitalize',
  },
  statusBadge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusBadgeActive: {
    backgroundColor: 'rgba(0, 230, 118, 0.15)',
  },
  statusBadgeFree: {
    backgroundColor: 'rgba(100, 116, 139, 0.15)',
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  statusActive: {
    color: colors.green,
  },
  statusFree: {
    color: colors.textSubtle,
  },
  renewsText: {
    color: colors.textSubtle,
    fontSize: 13,
    marginTop: 4,
  },
  freeNote: {
    color: colors.textSubtle,
    fontSize: 13,
    marginTop: 4,
  },
  manageButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  manageButtonText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  intervalToggle: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 3,
  },
  intervalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 4,
  },
  intervalOptionActive: {
    backgroundColor: colors.indigo,
  },
  intervalText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  intervalTextActive: {
    color: colors.white,
  },
  saveBadge: {
    backgroundColor: 'rgba(0, 230, 118, 0.2)',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  saveBadgeText: {
    color: colors.green,
    fontSize: 10,
    fontWeight: '700',
  },
  trialBadge: {
    position: 'absolute',
    top: 0,
    right: 0,
    backgroundColor: colors.green,
    borderBottomLeftRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  trialBadgeBiz: {
    backgroundColor: colors.indigo,
  },
  trialBadgeText: {
    color: colors.bg,
    fontSize: 11,
    fontWeight: '800',
  },
  trialBadgeTextBiz: {
    color: colors.white,
  },
  planHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  planHeaderTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
  priceBadge: {
    backgroundColor: 'rgba(92, 107, 192, 0.15)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  priceBadgeGreen: {
    backgroundColor: 'rgba(0, 230, 118, 0.15)',
  },
  priceBadgeText: {
    color: colors.indigo,
    fontSize: 13,
    fontWeight: '700',
  },
  saveText: {
    color: colors.green,
    fontSize: 12,
    fontWeight: '600',
  },
  perMonth: {
    color: colors.textSubtle,
    fontSize: 12,
    marginBottom: 8,
  },
  features: {
    gap: 4,
    marginBottom: 12,
  },
  feature: {
    color: colors.textMuted,
    fontSize: 14,
  },
  trialNote: {
    color: colors.green,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 16,
  },
  upgradeButton: {
    backgroundColor: colors.green,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  upgradeButtonText: {
    color: colors.bg,
    fontSize: 15,
    fontWeight: '700',
  },
  upgradeButtonSecondary: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  upgradeButtonSecondaryText: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  paidCard: {
    backgroundColor: 'rgba(0, 230, 118, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(0, 230, 118, 0.3)',
    borderRadius: 16,
    padding: 20,
  },
  paidText: {
    color: colors.green,
    fontSize: 14,
    marginBottom: 12,
  },
});

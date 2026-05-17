import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Share,
  Platform,
  Modal,
} from 'react-native';
import { colors } from '../../theme/colors';
import { api, Estimate, API_BASE_URL } from '../../api/client';
import { hapticLight } from '../../utils/haptics';
import PdfViewer from '../../components/PdfViewer';
import type { EstimateDetailScreenProps } from '../../navigation/types';

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function parseCost(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  if (!match) return null;
  const raw = match[1].replace(/[,$\s]/g, '');
  const num = parseFloat(raw);
  return isNaN(num) ? null : num;
}

function extractCosts(text: string): { materials: number | null; labor: number | null; total: number | null } {
  const materials = parseCost(text, /materials?\s*(?:cost|estimate)?[:\s]*\$?([\d,]+(?:\.\d{2})?)/i);
  const labor = parseCost(text, /labor\s*(?:cost|estimate)?[:\s]*\$?([\d,]+(?:\.\d{2})?)/i);
  let total = parseCost(text, /total\s*(?:cost|estimate|project)?[:\s]*\$?([\d,]+(?:\.\d{2})?)/i);
  if (total == null && materials != null && labor != null) {
    total = materials + labor;
  }
  return { materials, labor, total };
}

function formatCurrency(value: number | null): string {
  if (value == null) return '--';
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export default function EstimateDetailScreen({ route, navigation }: EstimateDetailScreenProps) {
  const { id } = route.params;
  const [loading, setLoading] = useState(true);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [error, setError] = useState('');
  const [showPdf, setShowPdf] = useState(false);

  useEffect(() => {
    loadEstimate();
  }, [id]);

  const loadEstimate = async () => {
    try {
      const res = await api.getEstimate(id);
      if (res.data) setEstimate(res.data);
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message ?? 'Failed to load estimate.');
      } else {
        setError('Failed to load estimate.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleViewPdf = () => {
    hapticLight();
    setShowPdf(true);
  };

  const handleShare = async () => {
    const pdfUrl = `${API_BASE_URL}/estimate/${id}/pdf`;
    const shareCosts = estimate ? extractCosts(estimate.estimateText) : { materials: null, labor: null, total: null };
    const dateStr = estimate ? formatDate(estimate.createdAt) : '';

    const lines: string[] = [];
    lines.push(`📋 ProBid AI Estimate`);
    lines.push(`────────────────────`);
    if (estimate?.jobType) lines.push(`Job: ${estimate.jobType}`);
    if (estimate?.market) lines.push(`Market: ${estimate.market}`);
    if (dateStr) lines.push(`Date: ${dateStr}`);
    lines.push('');
    if (shareCosts.materials != null) lines.push(`Materials: ${formatCurrency(shareCosts.materials)}`);
    if (shareCosts.labor != null) lines.push(`Labor: ${formatCurrency(shareCosts.labor)}`);
    if (shareCosts.total != null) lines.push(`Total: ${formatCurrency(shareCosts.total)}`);
    lines.push('');
    if (estimate?.clientName) lines.push(`Client: ${estimate.clientName}`);
    lines.push(`View full PDF: ${pdfUrl}`);

    const summary = lines.join('\n');

    hapticLight();
    try {
      await Share.share({
        message: summary,
        url: Platform.OS === 'ios' ? pdfUrl : undefined,
        title: `Estimate - ${estimate?.jobType ?? 'ProBid AI'}`,
      });
    } catch {}
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.green} />
      </View>
    );
  }

  if (error || !estimate) {
    return (
      <View style={styles.loadingContainer}>
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>
            {error || 'Estimate not found.'}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.backLink}
          onPress={() => navigation.goBack()}>
          <Text style={styles.backLinkText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const regexCosts = extractCosts(estimate.estimateText);
  const materials = estimate.materials ?? regexCosts.materials;
  const labor = estimate.labor ?? regexCosts.labor;
  const total = estimate.total ?? regexCosts.total ?? (materials != null && labor != null ? materials + labor : null);
  const costs = { materials, labor, total };
  const pdfUrl = `${API_BASE_URL}/estimate/${id}/pdf`;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <Modal visible={showPdf} animationType="slide" presentationStyle="fullScreen">
        <PdfViewer
          url={pdfUrl}
          title={`${estimate.jobType} - PDF`}
          onClose={() => setShowPdf(false)}
        />
      </Modal>
      <View style={styles.header}>
        <Text style={styles.title}>{estimate.jobType}</Text>
        <View style={styles.metaRow}>
          <Text style={styles.date}>{formatDate(estimate.createdAt)}</Text>
          <Text style={styles.marketBadgeText}>· {estimate.market}</Text>
        </View>
      </View>

      {(costs.materials != null || costs.labor != null || costs.total != null) && (
        <View style={styles.costGrid}>
          <View style={styles.costTile}>
            <Text style={styles.costLabel}>Materials</Text>
            <Text style={styles.costValue}>{formatCurrency(costs.materials)}</Text>
          </View>
          <View style={styles.costTile}>
            <Text style={styles.costLabel}>Labor</Text>
            <Text style={styles.costValue}>{formatCurrency(costs.labor)}</Text>
          </View>
          <View style={[styles.costTile, styles.costTileTotal]}>
            <Text style={styles.costLabel}>Total</Text>
            <Text style={[styles.costValue, styles.costValueTotal]}>
              {formatCurrency(costs.total)}
            </Text>
          </View>
        </View>
      )}

      <View style={styles.breakdownCard}>
        <Text style={styles.breakdownTitle}>Detailed Breakdown</Text>
        <Text style={styles.estimateText}>{estimate.estimateText}</Text>
      </View>

      {(estimate.clientName || estimate.clientEmail || estimate.clientPhone) && (
        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>Client Information</Text>
          {estimate.clientName && (
            <Text style={styles.infoRow}>
              <Text style={styles.infoLabel}>Name: </Text>
              {estimate.clientName}
            </Text>
          )}
          {estimate.clientEmail && (
            <Text style={styles.infoRow}>
              <Text style={styles.infoLabel}>Email: </Text>
              {estimate.clientEmail}
            </Text>
          )}
          {estimate.clientPhone && (
            <Text style={styles.infoRow}>
              <Text style={styles.infoLabel}>Phone: </Text>
              {estimate.clientPhone}
            </Text>
          )}
        </View>
      )}

      {estimate.details && (
        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>Job Description</Text>
          <Text style={styles.infoText}>{estimate.details}</Text>
        </View>
      )}

      <TouchableOpacity style={styles.primaryButton} onPress={handleViewPdf}>
        <Text style={styles.primaryButtonText}>View PDF</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.secondaryButton} onPress={handleShare}>
        <Text style={styles.secondaryButtonText}>Share Estimate</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.ghostButton}
        onPress={() => navigation.navigate('NewEstimate')}>
        <Text style={styles.ghostButtonText}>New Estimate</Text>
      </TouchableOpacity>
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
    padding: 20,
  },
  header: {
    marginBottom: 20,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 26,
    fontWeight: '900',
    textTransform: 'capitalize',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  date: {
    color: colors.textSubtle,
    fontSize: 13,
  },
  marketBadgeText: {
    color: colors.textSubtle,
    fontSize: 13,
    textTransform: 'capitalize',
  },
  costGrid: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  costTile: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    alignItems: 'center',
  },
  costTileTotal: {
    borderColor: 'rgba(0, 230, 118, 0.3)',
  },
  costLabel: {
    color: colors.textSubtle,
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 4,
  },
  costValue: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '800',
  },
  costValueTotal: {
    color: colors.green,
  },
  breakdownCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    marginBottom: 12,
  },
  breakdownTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  estimateText: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 22,
  },
  infoCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    marginBottom: 12,
  },
  infoTitle: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 10,
  },
  infoRow: {
    color: colors.textMuted,
    fontSize: 14,
    marginBottom: 4,
  },
  infoLabel: {
    color: colors.textSubtle,
  },
  infoText: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
  },
  primaryButton: {
    backgroundColor: colors.green,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 10,
    marginTop: 8,
  },
  primaryButtonText: {
    color: colors.bg,
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 10,
  },
  secondaryButtonText: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  ghostButton: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  ghostButtonText: {
    color: colors.textMuted,
    fontSize: 16,
    fontWeight: '500',
  },
  errorBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  errorText: {
    color: colors.red,
    fontSize: 14,
  },
  backLink: {
    marginTop: 8,
  },
  backLinkText: {
    color: colors.green,
    fontSize: 14,
    fontWeight: '600',
  },
});

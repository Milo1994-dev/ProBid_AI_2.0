import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../../theme/colors';
import { api, ApiError, SavedLineItemPayload, SavedLineItemPreset } from '../../api/client';
import { hapticError, hapticLight, hapticSuccess } from '../../utils/haptics';
import { useNetwork } from '../../contexts/NetworkContext';
import type { SavedLineItemsScreenProps } from '../../navigation/types';

const COST_TYPE_OPTIONS = [
  '',
  'Materials',
  'Labor',
  'Equipment',
  'Subcontractor',
  'Permit',
  'Overhead',
  'Other',
];

const UOM_SUGGESTIONS = ['', 'ea', 'hr', 'sq ft', 'lin ft', 'yd³', 'ton', 'lb', 'gal', 'lot'];

const MAX_DESCRIPTION = 500;
const MAX_UOM = 32;
const MAX_COST_TYPE = 64;

interface RowDraft {
  description: string;
  quantity: string;
  unitCost: string;
  uom: string;
  costType: string;
}

function emptyRow(): RowDraft {
  return { description: '', quantity: '1', unitCost: '', uom: '', costType: '' };
}

function parseNumber(value: string): number {
  if (typeof value !== 'string') return NaN;
  const cleaned = value.replace(/[$,\s]/g, '');
  if (cleaned === '') return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function formatCurrency(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(n);
}

function rowToPayload(row: RowDraft):
  | { ok: true; payload: SavedLineItemPayload }
  | { ok: false; error: string } {
  const description = row.description.trim();
  if (!description) {
    return { ok: false, error: 'Add a description before saving as a preset.' };
  }
  if (description.length > MAX_DESCRIPTION) {
    return { ok: false, error: `Description must be ${MAX_DESCRIPTION} characters or fewer.` };
  }
  const q = parseNumber(row.quantity);
  if (!Number.isFinite(q) || q <= 0) {
    return { ok: false, error: 'Quantity must be greater than zero.' };
  }
  const u = parseNumber(row.unitCost);
  if (!Number.isFinite(u) || u < 0) {
    return { ok: false, error: 'Unit cost must be a number ≥ 0.' };
  }
  const uom = row.uom.trim();
  if (uom.length > MAX_UOM) {
    return { ok: false, error: `Unit of measure must be ${MAX_UOM} characters or fewer.` };
  }
  const costType = row.costType.trim();
  if (costType.length > MAX_COST_TYPE) {
    return { ok: false, error: `Cost type must be ${MAX_COST_TYPE} characters or fewer.` };
  }
  const payload: SavedLineItemPayload = {
    description,
    quantity: q,
    unitCost: u,
  };
  if (uom) payload.uom = uom;
  if (costType) payload.costType = costType;
  return { ok: true, payload };
}

function describePreset(p: SavedLineItemPreset): string {
  const qty = `${p.quantity}${p.uom ? ' ' + p.uom : ''}`;
  return `${p.description} — ${qty} × ${formatCurrency(p.unitCost)}`;
}

export default function SavedLineItemsScreen({ navigation, route }: SavedLineItemsScreenProps) {
  const { isConnected } = useNetwork();
  const mode = route.params?.mode ?? 'manage';

  const [presets, setPresets] = useState<SavedLineItemPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [draft, setDraft] = useState<RowDraft>(emptyRow());
  const [draftError, setDraftError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedToast, setSavedToast] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(mode === 'manage');

  const loadPresets = useCallback(async () => {
    try {
      const res = await api.getSavedLineItems();
      const list = res.data?.presets ?? [];
      setPresets(list);
      setError('');
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      setError(apiErr.apiError ?? apiErr.message ?? 'Failed to load saved line items.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadPresets();
  }, [loadPresets]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadPresets();
  };

  const draftLineTotal = useMemo(() => {
    const q = parseNumber(draft.quantity);
    const u = parseNumber(draft.unitCost);
    if (!Number.isFinite(q) || !Number.isFinite(u)) return null;
    return Math.round(q * u * 100) / 100;
  }, [draft.quantity, draft.unitCost]);

  const updateDraft = (patch: Partial<RowDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    if (draftError) setDraftError('');
    if (savedToast) setSavedToast('');
  };

  const handleSavePreset = async () => {
    setDraftError('');
    setSavedToast('');
    if (!isConnected) {
      setDraftError('You need an internet connection to save a preset.');
      return;
    }
    const result = rowToPayload(draft);
    if (!result.ok) {
      hapticError();
      setDraftError(result.error);
      return;
    }
    setSaving(true);
    try {
      const res = await api.createSavedLineItem(result.payload);
      const newPreset = res.data?.preset;
      if (newPreset) {
        setPresets((prev) =>
          [...prev, newPreset].sort((a, b) =>
            a.description.localeCompare(b.description, undefined, { sensitivity: 'base' }),
          ),
        );
      } else {
        // Fallback: refetch if the API didn't return the new row.
        loadPresets();
      }
      hapticSuccess();
      setSavedToast(`Saved "${result.payload.description}" to your library.`);
      setDraft(emptyRow());
    } catch (err: unknown) {
      hapticError();
      const apiErr = err as ApiError;
      setDraftError(apiErr.apiError ?? apiErr.message ?? 'Failed to save preset.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (preset: SavedLineItemPreset) => {
    Alert.alert(
      'Delete preset',
      `Delete "${preset.description}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (!isConnected) {
              Alert.alert('Offline', 'You need an internet connection to delete a preset.');
              return;
            }
            setDeletingId(preset.id);
            try {
              await api.deleteSavedLineItem(preset.id);
              setPresets((prev) => prev.filter((p) => p.id !== preset.id));
              hapticLight();
            } catch (err: unknown) {
              hapticError();
              const apiErr = err as ApiError;
              Alert.alert(
                'Delete failed',
                apiErr.apiError ?? apiErr.message ?? 'Could not delete this preset.',
              );
            } finally {
              setDeletingId(null);
            }
          },
        },
      ],
    );
  };

  const handleInsert = (preset: SavedLineItemPreset) => {
    hapticLight();
    navigation.navigate('NewEstimate', {
      insertPresetSummary: describePreset(preset),
    });
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.green}
          />
        }>
        <Text style={styles.title}>Saved Line Items</Text>
        <Text style={styles.subtitle}>
          {mode === 'picker'
            ? 'Tap a preset to add its description into your new estimate.'
            : 'Reusable line items you can pull into estimates from any device.'}
        </Text>

        {!showAddForm && (
          <TouchableOpacity
            style={styles.addToggle}
            onPress={() => {
              hapticLight();
              setShowAddForm(true);
            }}>
            <Text style={styles.addToggleIcon}>＋</Text>
            <Text style={styles.addToggleText}>Save a new line item as preset</Text>
          </TouchableOpacity>
        )}

        {showAddForm && (
          <View style={styles.formCard}>
            <View style={styles.formHeader}>
              <Text style={styles.formTitle}>New preset</Text>
              {mode === 'picker' && (
                <TouchableOpacity onPress={() => setShowAddForm(false)}>
                  <Text style={styles.formHeaderHide}>Hide</Text>
                </TouchableOpacity>
              )}
            </View>

            <Text style={styles.fieldLabel}>Description</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Tuckpoint repair, 100 sq ft"
              placeholderTextColor={colors.textSubtle}
              value={draft.description}
              onChangeText={(t) => updateDraft({ description: t })}
              maxLength={MAX_DESCRIPTION}
              multiline
            />

            <View style={styles.row}>
              <View style={styles.col}>
                <Text style={styles.fieldLabel}>Quantity</Text>
                <TextInput
                  style={styles.input}
                  placeholder="1"
                  placeholderTextColor={colors.textSubtle}
                  value={draft.quantity}
                  onChangeText={(t) => updateDraft({ quantity: t })}
                  keyboardType="decimal-pad"
                />
              </View>
              <View style={styles.col}>
                <Text style={styles.fieldLabel}>Unit cost</Text>
                <TextInput
                  style={styles.input}
                  placeholder="0.00"
                  placeholderTextColor={colors.textSubtle}
                  value={draft.unitCost}
                  onChangeText={(t) => updateDraft({ unitCost: t })}
                  keyboardType="decimal-pad"
                />
              </View>
            </View>

            <Text style={styles.fieldLabel}>
              Unit of measure <Text style={styles.optional}>(optional)</Text>
            </Text>
            <View style={styles.pillRow}>
              {UOM_SUGGESTIONS.map((option) => {
                const label = option || 'None';
                const active = draft.uom === option;
                return (
                  <TouchableOpacity
                    key={`uom-${option || 'none'}`}
                    style={[styles.pill, active && styles.pillActive]}
                    onPress={() => updateDraft({ uom: option })}>
                    <Text style={[styles.pillText, active && styles.pillTextActive]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.fieldLabel}>
              Cost type <Text style={styles.optional}>(optional)</Text>
            </Text>
            <View style={styles.pillRow}>
              {COST_TYPE_OPTIONS.map((option) => {
                const label = option || 'None';
                const active = draft.costType === option;
                return (
                  <TouchableOpacity
                    key={`ct-${option || 'none'}`}
                    style={[styles.pill, active && styles.pillActive]}
                    onPress={() => updateDraft({ costType: option })}>
                    <Text style={[styles.pillText, active && styles.pillTextActive]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {draftLineTotal != null && (
              <Text style={styles.totalHint}>Line total: {formatCurrency(draftLineTotal)}</Text>
            )}

            {draftError ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{draftError}</Text>
              </View>
            ) : null}

            {savedToast ? (
              <View style={styles.successBox}>
                <Text style={styles.successText}>{savedToast}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              style={[styles.savePresetButton, saving && styles.savePresetButtonDisabled]}
              onPress={handleSavePreset}
              disabled={saving}>
              {saving ? (
                <ActivityIndicator color={colors.bg} />
              ) : (
                <Text style={styles.savePresetButtonText}>Save row as preset</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        <Text style={styles.sectionTitle}>
          Your library {presets.length > 0 ? `(${presets.length})` : ''}
        </Text>

        {loading ? (
          <View style={styles.loadingBlock}>
            <ActivityIndicator color={colors.green} />
          </View>
        ) : error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : presets.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No saved line items yet</Text>
            <Text style={styles.emptyText}>
              Save reusable rows here so they appear instantly on every device — phone, tablet,
              or laptop.
            </Text>
          </View>
        ) : (
          presets.map((preset) => {
            const lineTotal = preset.quantity * preset.unitCost;
            return (
              <View key={preset.id} style={styles.presetCard}>
                <Text style={styles.presetDescription}>{preset.description}</Text>
                <View style={styles.presetMetaRow}>
                  <Text style={styles.presetMeta}>
                    {preset.quantity}
                    {preset.uom ? ` ${preset.uom}` : ''} × {formatCurrency(preset.unitCost)}
                  </Text>
                  <Text style={styles.presetTotal}>{formatCurrency(lineTotal)}</Text>
                </View>
                {preset.costType ? (
                  <Text style={styles.presetTag}>{preset.costType}</Text>
                ) : null}
                <View style={styles.presetActions}>
                  {mode === 'picker' && (
                    <TouchableOpacity
                      style={styles.insertButton}
                      onPress={() => handleInsert(preset)}>
                      <Text style={styles.insertButtonText}>Add to description</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={[
                      styles.deleteButton,
                      deletingId === preset.id && styles.deleteButtonDisabled,
                    ]}
                    onPress={() => handleDelete(preset)}
                    disabled={deletingId === preset.id}>
                    {deletingId === preset.id ? (
                      <ActivityIndicator size="small" color={colors.red} />
                    ) : (
                      <Text style={styles.deleteButtonText}>Delete</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 60,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 26,
    fontWeight: '900',
    marginBottom: 6,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 14,
    marginBottom: 20,
    lineHeight: 20,
  },
  addToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 16,
    gap: 10,
  },
  addToggleIcon: {
    color: colors.green,
    fontSize: 22,
    fontWeight: '700',
  },
  addToggleText: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  formCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    marginBottom: 24,
  },
  formHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  formTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  formHeaderHide: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 8,
  },
  optional: {
    color: colors.textSubtle,
    fontWeight: '400',
  },
  input: {
    backgroundColor: colors.inputBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  col: {
    flex: 1,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  pill: {
    backgroundColor: colors.inputBg,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pillActive: {
    backgroundColor: 'rgba(0, 230, 118, 0.15)',
    borderColor: colors.green,
  },
  pillText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '500',
  },
  pillTextActive: {
    color: colors.green,
    fontWeight: '700',
  },
  totalHint: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 12,
  },
  errorBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
  },
  errorText: {
    color: colors.red,
    fontSize: 13,
  },
  successBox: {
    backgroundColor: 'rgba(0, 230, 118, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(0, 230, 118, 0.3)',
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
  },
  successText: {
    color: colors.green,
    fontSize: 13,
    fontWeight: '600',
  },
  savePresetButton: {
    backgroundColor: colors.green,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
  },
  savePresetButtonDisabled: {
    opacity: 0.7,
  },
  savePresetButtonText: {
    color: colors.bg,
    fontSize: 15,
    fontWeight: '700',
  },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
    marginTop: 4,
  },
  loadingBlock: {
    paddingVertical: 24,
    alignItems: 'center',
  },
  emptyState: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    alignItems: 'center',
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 6,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },
  presetCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 10,
  },
  presetDescription: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 6,
  },
  presetMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  presetMeta: {
    color: colors.textMuted,
    fontSize: 13,
  },
  presetTotal: {
    color: colors.green,
    fontSize: 14,
    fontWeight: '700',
  },
  presetTag: {
    color: colors.textSubtle,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 4,
  },
  presetActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  insertButton: {
    flex: 1,
    backgroundColor: 'rgba(0, 230, 118, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0, 230, 118, 0.4)',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  insertButtonText: {
    color: colors.green,
    fontSize: 13,
    fontWeight: '700',
  },
  deleteButton: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    minWidth: 88,
  },
  deleteButtonDisabled: {
    opacity: 0.6,
  },
  deleteButtonText: {
    color: colors.red,
    fontSize: 13,
    fontWeight: '700',
  },
});

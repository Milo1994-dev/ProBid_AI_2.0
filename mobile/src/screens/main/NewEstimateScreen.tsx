import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Image,
  ActivityIndicator,
  Alert,
  Platform,
  Modal,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { colors } from '../../theme/colors';
import { useNetwork } from '../../contexts/NetworkContext';
import { api, EstimateResult, EstimateTemplate, ApiError, JOB_TYPES, MARKETS, TRADE_PRESETS, UsageData, API_BASE_URL } from '../../api/client';
import { hapticSuccess, hapticError, hapticLight } from '../../utils/haptics';
import { enqueueEstimate } from '../../services/offlineQueue';
import StepProgressIndicator from '../../components/StepProgressIndicator';
import PdfViewer from '../../components/PdfViewer';
import type { NewEstimateScreenProps } from '../../navigation/types';

const MAX_FILES = 5;

interface ImageFormPart {
  uri: string;
  name: string;
  type: string;
}

export default function NewEstimateScreen({ navigation, route }: NewEstimateScreenProps) {
  const { isConnected } = useNetwork();
  const [images, setImages] = useState<ImagePicker.ImagePickerAsset[]>([]);
  const [description, setDescription] = useState('');
  const [jobType, setJobType] = useState('general');
  const [market, setMarket] = useState('midwest');
  const [tradePreset, setTradePreset] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<EstimateResult | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [showPdf, setShowPdf] = useState(false);

  const [clientName, setClientName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [clientPhone, setClientPhone] = useState('');

  const [templates, setTemplates] = useState<EstimateTemplate[]>([]);
  const [templatePickerVisible, setTemplatePickerVisible] = useState(false);
  const [saveTemplateVisible, setSaveTemplateVisible] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);

  useEffect(() => {
    if (isConnected) {
      api.getUsage().then((r) => {
        if (r.data) setUsage(r.data);
      });
      loadTemplates();
    }
  }, [isConnected]);

  useEffect(() => {
    const params = route.params;
    if (params?.templateJobType) setJobType(params.templateJobType);
    if (params?.templateMarket) setMarket(params.templateMarket);
    if (params?.templateDetails) setDescription(params.templateDetails);
    if (params?.templateClientName) setClientName(params.templateClientName);
    if (params?.templateClientEmail) setClientEmail(params.templateClientEmail);
    if (params?.templateClientPhone) setClientPhone(params.templateClientPhone);
    if (params?.openTemplates) {
      setTemplatePickerVisible(true);
      navigation.setParams({ openTemplates: undefined });
    }
  }, [route.params?.templateJobType, route.params?.templateMarket, route.params?.templateDetails, route.params?.openTemplates]);

  useEffect(() => {
    const params = route.params;
    if (params?.annotatedImageUri != null && params?.annotatedImageIndex != null) {
      setImages((prev) => {
        const updated = [...prev];
        if (params.annotatedImageIndex! < updated.length) {
          updated[params.annotatedImageIndex!] = {
            ...updated[params.annotatedImageIndex!],
            uri: params.annotatedImageUri!,
          };
        }
        return updated;
      });
      navigation.setParams({ annotatedImageUri: undefined, annotatedImageIndex: undefined });
    }
  }, [route.params?.annotatedImageUri, route.params?.annotatedImageIndex]);

  useEffect(() => {
    const summary = route.params?.insertPresetSummary;
    if (summary) {
      setDescription((prev) => {
        const trimmed = prev.trim();
        if (!trimmed) return summary;
        if (trimmed.includes(summary)) return prev;
        return `${trimmed}\n• ${summary}`;
      });
      navigation.setParams({ insertPresetSummary: undefined });
    }
  }, [route.params?.insertPresetSummary]);

  const loadTemplates = async () => {
    try {
      const res = await api.getTemplates();
      if (res.data) setTemplates(Array.isArray(res.data) ? res.data : []);
    } catch {}
  };

  const applyTemplate = (t: EstimateTemplate) => {
    const matchedJobType = JOB_TYPES.find(
      (jt) => jt.value === t.jobType || jt.label === t.jobType,
    );
    if (matchedJobType) setJobType(matchedJobType.value);
    const matchedMarket = MARKETS.find(
      (m) => m.value === t.market || m.label === t.market,
    );
    if (matchedMarket) setMarket(matchedMarket.value);
    if (t.details) setDescription(t.details);
    if (t.clientName) setClientName(t.clientName);
    if (t.clientEmail) setClientEmail(t.clientEmail);
    if (t.clientPhone) setClientPhone(t.clientPhone);
    setTemplatePickerVisible(false);
  };

  const handleDeleteTemplate = (id: string) => {
    Alert.alert('Delete Template', 'Are you sure you want to delete this template?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteTemplate(id);
            setTemplates((prev) => prev.filter((t) => t.id !== id));
          } catch {}
        },
      },
    ]);
  };

  const handleSaveTemplate = async () => {
    if (!templateName.trim()) {
      Alert.alert('Name Required', 'Please enter a name for this template.');
      return;
    }
    setSavingTemplate(true);
    try {
      const selectedJobType = JOB_TYPES.find((jt) => jt.value === jobType);
      await api.createTemplate({
        name: templateName.trim(),
        jobType: selectedJobType?.label ?? jobType,
        market,
        details: description || undefined,
        clientName: clientName || undefined,
        clientEmail: clientEmail || undefined,
        clientPhone: clientPhone || undefined,
      });
      setSaveTemplateVisible(false);
      setTemplateName('');
      loadTemplates();
      Alert.alert('Saved', 'Template saved successfully.');
    } catch {
      Alert.alert('Error', 'Failed to save template.');
    } finally {
      setSavingTemplate(false);
    }
  };

  const estimatesLeft =
    usage && !usage.isUnlimited && usage.limit != null
      ? Math.max(0, usage.limit - usage.used)
      : null;

  const pickFromLibrary = async () => {
    const remaining = MAX_FILES - images.length;
    if (remaining <= 0) {
      Alert.alert('Limit Reached', `Maximum ${MAX_FILES} images allowed.`);
      return;
    }

    const permResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permResult.granted) {
      Alert.alert('Permission Required', 'Please allow photo library access in settings.');
      return;
    }

    const pickerResult = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 0.8,
    });

    if (!pickerResult.canceled) {
      setImages((prev) => [...prev, ...pickerResult.assets].slice(0, MAX_FILES));
    }
  };

  const takePhoto = async () => {
    if (images.length >= MAX_FILES) {
      Alert.alert('Limit Reached', `Maximum ${MAX_FILES} images allowed.`);
      return;
    }

    const permResult = await ImagePicker.requestCameraPermissionsAsync();
    if (!permResult.granted) {
      Alert.alert('Permission Required', 'Please allow camera access in settings.');
      return;
    }

    const cameraResult = await ImagePicker.launchCameraAsync({
      quality: 0.8,
    });

    if (!cameraResult.canceled) {
      setImages((prev) => [...prev, ...cameraResult.assets].slice(0, MAX_FILES));
    }
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const openAnnotation = (index: number) => {
    const img = images[index];
    if (img) {
      navigation.navigate('PhotoAnnotation', { imageUri: img.uri, imageIndex: index });
    }
  };

  const handleSubmit = async () => {
    setError('');
    if (images.length === 0 && !description.trim()) {
      hapticError();
      setError('Please upload at least one photo or provide a description.');
      return;
    }
    hapticLight();

    if (!isConnected) {
      const selectedJobType = JOB_TYPES.find((jt) => jt.value === jobType);
      await enqueueEstimate({
        jobType: selectedJobType?.label ?? jobType,
        market,
        tradePreset: tradePreset || undefined,
        details: description || undefined,
        imageUris: images.map((img) => img.uri),
      });
      Alert.alert(
        'Queued for Submission',
        'Your estimate has been saved and will be submitted automatically when you reconnect.',
      );
      handleNewEstimate();
      return;
    }

    setSubmitting(true);
    const formData = new FormData();
    const selectedJobType = JOB_TYPES.find((jt) => jt.value === jobType);
    formData.append('jobType', selectedJobType?.label ?? jobType);
    formData.append('market', market);
    if (tradePreset) formData.append('tradePreset', tradePreset);
    if (description) formData.append('details', description);
    if (clientName) formData.append('clientName', clientName);
    if (clientEmail) formData.append('clientEmail', clientEmail);
    if (clientPhone) formData.append('clientPhone', clientPhone);

    images.forEach((img, i) => {
      const ext = img.uri.split('.').pop()?.toLowerCase() || 'jpg';
      const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
      const imagePart: ImageFormPart = {
        uri: img.uri,
        name: `photo_${i}.${ext}`,
        type: mimeType,
      };
      formData.append('photos', imagePart as unknown as Blob);
    });

    try {
      const res = await api.createEstimate(formData);
      if (!res.data || !res.data.estimateId || !res.data.text) {
        setError('Received an incomplete response from the server. Please try again.');
        return;
      }
      setResult(res.data);
      hapticSuccess();
    } catch (err: unknown) {
      hapticError();
      if (err instanceof Error) {
        const apiErr = err as ApiError;
        if (apiErr.status === 402) {
          Alert.alert(
            'Upgrade Required',
            'Estimate limit reached. Upgrade to Pro or buy a $7 single estimate to continue.',
            [
              { text: 'Later', style: 'cancel' },
              {
                text: 'Upgrade',
                onPress: () => navigation.navigate('Billing'),
              },
            ],
          );
        } else if (apiErr.status === 429) {
          const waitMins = apiErr.retryAfter ? Math.ceil(apiErr.retryAfter / 60) : null;
          setError(
            `Too many requests.${waitMins ? ` Please wait about ${waitMins} minute${waitMins !== 1 ? 's' : ''}.` : ' Please wait a few minutes.'}`,
          );
        } else {
          setError(apiErr.apiError ?? apiErr.message ?? 'Failed to generate estimate.');
        }
      } else {
        setError('Failed to generate estimate.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleViewPdf = () => {
    if (!result?.estimateId) return;
    hapticLight();
    setShowPdf(true);
  };

  const handleViewDetail = () => {
    if (!result?.estimateId) return;
    navigation.navigate('EstimateDetail', { id: result.estimateId });
  };

  const handleNewEstimate = () => {
    setResult(null);
    setImages([]);
    setDescription('');
    setClientName('');
    setClientEmail('');
    setClientPhone('');
    setError('');
  };

  const formatCurrency = (value: number | undefined): string => {
    if (value == null) return '--';
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  };

  if (result) {
    const pdfUrl = `${API_BASE_URL}/estimate/${result.estimateId}/pdf`;
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
        <Modal visible={showPdf} animationType="slide" presentationStyle="fullScreen">
          <PdfViewer
            url={pdfUrl}
            title="Estimate PDF"
            onClose={() => setShowPdf(false)}
          />
        </Modal>

        <View style={styles.successBanner}>
          <Text style={styles.successText}>Your estimate is ready!</Text>
        </View>

        {(result.materials != null || result.labor != null || result.total != null) && (
          <View style={styles.costGrid}>
            <View style={styles.costTile}>
              <Text style={styles.costLabel}>Materials</Text>
              <Text style={styles.costValue}>{formatCurrency(result.materials)}</Text>
            </View>
            <View style={styles.costTile}>
              <Text style={styles.costLabel}>Labor</Text>
              <Text style={styles.costValue}>{formatCurrency(result.labor)}</Text>
            </View>
            <View style={[styles.costTile, styles.costTileTotal]}>
              <Text style={styles.costLabel}>Total</Text>
              <Text style={[styles.costValue, styles.costValueTotal]}>
                {formatCurrency(result.total ?? (result.materials != null && result.labor != null ? result.materials + result.labor : undefined))}
              </Text>
            </View>
          </View>
        )}

        <View style={styles.resultCard}>
          <Text style={styles.resultTitle}>
            {description.substring(0, 80) || 'Construction Job'}
          </Text>
          <Text style={styles.resultText}>{result.text}</Text>
        </View>

        <TouchableOpacity style={styles.primaryButton} onPress={handleViewPdf}>
          <Text style={styles.primaryButtonText}>View PDF</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryButton} onPress={handleViewDetail}>
          <Text style={styles.secondaryButtonText}>View Details</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.saveTemplateButton}
          onPress={() => setSaveTemplateVisible(true)}>
          <Text style={styles.saveTemplateButtonText}>Save as Template</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.ghostButton} onPress={handleNewEstimate}>
          <Text style={styles.ghostButtonText}>New Estimate</Text>
        </TouchableOpacity>

        <Modal visible={saveTemplateVisible} transparent animationType="fade">
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Save as Template</Text>
              <Text style={styles.modalSubtitle}>
                Save this configuration to quickly create similar estimates.
              </Text>
              <TextInput
                style={styles.modalInput}
                placeholder="Template name (e.g. 2-Story Tuckpointing)"
                placeholderTextColor={colors.textSubtle}
                value={templateName}
                onChangeText={setTemplateName}
                autoFocus
              />
              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={styles.modalCancelButton}
                  onPress={() => { setSaveTemplateVisible(false); setTemplateName(''); }}>
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalSaveButton, savingTemplate && { opacity: 0.7 }]}
                  onPress={handleSaveTemplate}
                  disabled={savingTemplate}>
                  {savingTemplate ? (
                    <ActivityIndicator size="small" color={colors.bg} />
                  ) : (
                    <Text style={styles.modalSaveText}>Save</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled">
      <Text style={styles.screenTitle}>New Estimate</Text>
      <Text style={styles.screenSubtitle}>
        Upload photos and describe the job to get an AI-powered estimate.
      </Text>

      {templates.length > 0 && (
        <TouchableOpacity
          style={styles.templateButton}
          onPress={() => setTemplatePickerVisible(true)}>
          <Text style={styles.templateButtonIcon}>📋</Text>
          <Text style={styles.templateButtonText}>Load from Template</Text>
          <Text style={styles.templateButtonCount}>{templates.length}</Text>
        </TouchableOpacity>
      )}

      <View style={styles.selectorSection}>
        <Text style={styles.label}>Job Type</Text>
        <View style={styles.pillRow}>
          {JOB_TYPES.map((jt) => (
            <TouchableOpacity
              key={jt.value}
              style={[styles.pill, jobType === jt.value && styles.pillActive]}
              onPress={() => setJobType(jt.value)}>
              <Text style={[styles.pillText, jobType === jt.value && styles.pillTextActive]}>
                {jt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.selectorSection}>
        <Text style={styles.label}>Market / Region</Text>
        <View style={styles.pillRow}>
          {MARKETS.map((m) => (
            <TouchableOpacity
              key={m.value}
              style={[styles.pill, market === m.value && styles.pillActive]}
              onPress={() => setMarket(m.value)}>
              <Text style={[styles.pillText, market === m.value && styles.pillTextActive]}>
                {m.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.selectorSection}>
        <Text style={styles.label}>
          Trade Preset <Text style={styles.optional}>(optional)</Text>
        </Text>
        <View style={styles.pillRow}>
          {TRADE_PRESETS.map((tp) => (
            <TouchableOpacity
              key={tp.value}
              style={[styles.pill, tradePreset === tp.value && styles.pillActive]}
              onPress={() => setTradePreset(tp.value)}>
              <Text style={[styles.pillText, tradePreset === tp.value && styles.pillTextActive]}>
                {tp.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.clientSection}>
        <Text style={styles.label}>
          Client Information <Text style={styles.optional}>(optional)</Text>
        </Text>
        <TextInput
          style={styles.clientInput}
          placeholder="Client name"
          placeholderTextColor={colors.textSubtle}
          value={clientName}
          onChangeText={setClientName}
        />
        <TextInput
          style={styles.clientInput}
          placeholder="Client email"
          placeholderTextColor={colors.textSubtle}
          value={clientEmail}
          onChangeText={setClientEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <TextInput
          style={styles.clientInput}
          placeholder="Client phone"
          placeholderTextColor={colors.textSubtle}
          value={clientPhone}
          onChangeText={setClientPhone}
          keyboardType="phone-pad"
        />
      </View>

      <View style={styles.photoSection}>
        <Text style={styles.label}>
          Job Photos <Text style={styles.optional}>(optional)</Text>
        </Text>

        <View style={styles.photoButtons}>
          <TouchableOpacity style={styles.photoButton} onPress={takePhoto}>
            <Text style={styles.photoButtonIcon}>📷</Text>
            <Text style={styles.photoButtonText}>Take Photo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.photoButton} onPress={pickFromLibrary}>
            <Text style={styles.photoButtonIcon}>🖼️</Text>
            <Text style={styles.photoButtonText}>Choose from Library</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.photoHint}>
          Up to {MAX_FILES} photos · JPG, PNG, WebP · Max 10MB each · Tap to annotate
        </Text>

        {images.length > 0 && (
          <View style={styles.previewRow}>
            {images.map((img, i) => (
              <View key={i} style={styles.previewContainer}>
                <TouchableOpacity onPress={() => openAnnotation(i)} activeOpacity={0.7}>
                  <Image source={{ uri: img.uri }} style={styles.previewImage} />
                  <View style={styles.annotateOverlay}>
                    <Text style={styles.annotateOverlayText}>✏️</Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.removeButton}
                  onPress={() => removeImage(i)}>
                  <Text style={styles.removeButtonText}>×</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}
      </View>

      <View style={styles.descriptionSection}>
        <View style={styles.descriptionHeaderRow}>
          <Text style={styles.label}>Job Description</Text>
          <TouchableOpacity
            style={styles.libraryLink}
            onPress={() => navigation.navigate('SavedLineItems', { mode: 'picker' })}>
            <Text style={styles.libraryLinkText}>＋ Add from library</Text>
          </TouchableOpacity>
        </View>
        <TextInput
          style={styles.textarea}
          placeholder="Describe the job in detail. E.g.: Tuckpointing repair on a 2-story brick building, approximately 800 sq ft..."
          placeholderTextColor={colors.textSubtle}
          value={description}
          onChangeText={setDescription}
          multiline
          numberOfLines={5}
          textAlignVertical="top"
        />
        <Text style={styles.hint}>
          Be specific about materials, dimensions, and location for the most accurate estimate.
        </Text>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {submitting && <StepProgressIndicator />}

      {estimatesLeft === 1 && !submitting && (
        <View style={styles.warningBanner}>
          <Text style={styles.warningText}>
            ⚠️ This is your last estimate before upgrading.{' '}
            <Text
              style={styles.warningLink}
              onPress={() => navigation.navigate('Billing')}>
              Upgrade for unlimited
            </Text>
          </Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
        onPress={handleSubmit}
        disabled={submitting}>
        {submitting ? (
          <ActivityIndicator color={colors.bg} />
        ) : (
          <Text style={styles.submitButtonText}>Generate Estimate</Text>
        )}
      </TouchableOpacity>

      <Modal visible={templatePickerVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.templatePickerContent}>
            <View style={styles.templatePickerHeader}>
              <Text style={styles.modalTitle}>Saved Templates</Text>
              <TouchableOpacity onPress={() => setTemplatePickerVisible(false)}>
                <Text style={styles.templatePickerClose}>×</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.templateList}>
              {templates.map((t) => (
                <View key={t.id} style={styles.templateItem}>
                  <TouchableOpacity
                    style={styles.templateItemContent}
                    onPress={() => applyTemplate(t)}>
                    <Text style={styles.templateItemName}>{t.name}</Text>
                    <Text style={styles.templateItemMeta}>
                      {t.jobType} · {t.market}
                    </Text>
                    {t.details ? (
                      <Text style={styles.templateItemDetails} numberOfLines={1}>
                        {t.details}
                      </Text>
                    ) : null}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.templateDeleteButton}
                    onPress={() => handleDeleteTemplate(t.id)}>
                    <Text style={styles.templateDeleteText}>🗑️</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
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
  screenTitle: {
    color: colors.textPrimary,
    fontSize: 28,
    fontWeight: '900',
    marginBottom: 4,
  },
  screenSubtitle: {
    color: colors.textMuted,
    fontSize: 14,
    marginBottom: 24,
  },
  templateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(92, 107, 192, 0.3)',
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 20,
    gap: 10,
  },
  templateButtonIcon: {
    fontSize: 20,
  },
  templateButtonText: {
    color: colors.indigo,
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  templateButtonCount: {
    color: colors.textSubtle,
    fontSize: 13,
    backgroundColor: colors.bg,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  selectorSection: {
    marginBottom: 20,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  pill: {
    backgroundColor: colors.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 8,
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
  clientSection: {
    marginBottom: 24,
  },
  clientInput: {
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    color: colors.textPrimary,
    fontSize: 15,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 8,
  },
  photoSection: {
    marginBottom: 24,
  },
  label: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 8,
  },
  optional: {
    color: colors.textSubtle,
  },
  photoButtons: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
  },
  photoButton: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 20,
    alignItems: 'center',
    gap: 6,
  },
  photoButtonIcon: {
    fontSize: 28,
  },
  photoButtonText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '500',
  },
  photoHint: {
    color: colors.textSubtle,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
  },
  previewRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  previewContainer: {
    position: 'relative',
  },
  previewImage: {
    width: 72,
    height: 72,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  annotateOverlay: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 8,
    width: 22,
    height: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  annotateOverlayText: {
    fontSize: 11,
  },
  removeButton: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.red,
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeButtonText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 16,
  },
  descriptionSection: {
    marginBottom: 24,
  },
  descriptionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  libraryLink: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  libraryLinkText: {
    color: colors.green,
    fontSize: 13,
    fontWeight: '700',
  },
  textarea: {
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    color: colors.textPrimary,
    fontSize: 15,
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 120,
  },
  hint: {
    color: colors.textSubtle,
    fontSize: 12,
    marginTop: 6,
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
  processingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(92, 107, 192, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(92, 107, 192, 0.3)',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  processingText: {
    color: colors.indigo,
    fontSize: 13,
    flex: 1,
  },
  warningBanner: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  warningText: {
    color: colors.amber,
    fontSize: 13,
  },
  warningLink: {
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  submitButton: {
    backgroundColor: colors.green,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
  },
  submitButtonDisabled: {
    opacity: 0.7,
  },
  submitButtonText: {
    color: colors.bg,
    fontSize: 16,
    fontWeight: '800',
  },
  successBanner: {
    backgroundColor: 'rgba(0, 230, 118, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(0, 230, 118, 0.3)',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  successText: {
    color: colors.green,
    fontSize: 14,
    fontWeight: '600',
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
  resultCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    marginBottom: 16,
  },
  resultTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
    textTransform: 'capitalize',
  },
  resultText: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 22,
  },
  primaryButton: {
    backgroundColor: colors.green,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 10,
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
  saveTemplateButton: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(92, 107, 192, 0.3)',
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 10,
  },
  saveTemplateButtonText: {
    color: colors.indigo,
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
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 20,
    width: '100%',
    maxWidth: 360,
  },
  modalTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  modalSubtitle: {
    color: colors.textSubtle,
    fontSize: 13,
    marginBottom: 16,
  },
  modalInput: {
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    color: colors.textPrimary,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 16,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  modalCancelButton: {
    flex: 1,
    backgroundColor: colors.bg,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalCancelText: {
    color: colors.textMuted,
    fontSize: 16,
    fontWeight: '600',
  },
  modalSaveButton: {
    flex: 1,
    backgroundColor: colors.green,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalSaveText: {
    color: colors.bg,
    fontSize: 16,
    fontWeight: '700',
  },
  templatePickerContent: {
    backgroundColor: colors.card,
    borderRadius: 16,
    width: '100%',
    maxWidth: 400,
    maxHeight: '70%',
    padding: 20,
  },
  templatePickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  templatePickerClose: {
    color: colors.textMuted,
    fontSize: 28,
    fontWeight: '300',
    paddingHorizontal: 8,
  },
  templateList: {
    flexGrow: 0,
  },
  templateItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  templateItemContent: {
    flex: 1,
  },
  templateItemName: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  templateItemMeta: {
    color: colors.textSubtle,
    fontSize: 12,
    textTransform: 'capitalize',
  },
  templateItemDetails: {
    color: colors.textSubtle,
    fontSize: 12,
    marginTop: 2,
  },
  templateDeleteButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  templateDeleteText: {
    fontSize: 16,
  },
});

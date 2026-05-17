import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { colors } from '../../theme/colors';
import { useNetwork } from '../../contexts/NetworkContext';
import { api, Estimate } from '../../api/client';
import { cacheEstimates, getCachedEstimates } from '../../services/offlineCache';
import type { HistoryScreenProps } from '../../navigation/types';

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function HistoryScreen({ navigation }: HistoryScreenProps) {
  const { isConnected } = useNetwork();
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [isOfflineData, setIsOfflineData] = useState(false);

  const [error, setError] = useState('');

  const loadEstimates = useCallback(
    async (p: number, s: string, append = false) => {
      if (!isConnected) {
        const cached = await getCachedEstimates();
        const filtered = s
          ? cached.filter(
              (e) =>
                e.jobType.toLowerCase().includes(s.toLowerCase()) ||
                (e.details ?? '').toLowerCase().includes(s.toLowerCase()),
            )
          : cached;
        setEstimates(filtered);
        setTotal(filtered.length);
        setPages(1);
        setIsOfflineData(true);
        setLoading(false);
        setLoadingMore(false);
        return;
      }

      if (!append) setLoading(true);
      else setLoadingMore(true);
      try {
        setError('');
        const res = await api.getEstimates(p, s);
        if (res.data) {
          setEstimates((prev) =>
            append ? [...prev, ...res.data!.estimates] : res.data!.estimates,
          );
          setTotal(res.data.total);
          setPages(res.data.pages);
          if (p === 1 && !s) {
            cacheEstimates(res.data.estimates);
          }
        }
        setIsOfflineData(false);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to load estimates.';
        setError(message);
        if (!append) {
          const cached = await getCachedEstimates();
          if (cached.length > 0) {
            setEstimates(cached);
            setTotal(cached.length);
            setIsOfflineData(true);
          }
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [isConnected],
  );

  useFocusEffect(
    useCallback(() => {
      setPage(1);
      loadEstimates(1, search);
    }, [search, loadEstimates]),
  );

  const handleSearch = () => {
    setSearch(searchInput.trim());
    setPage(1);
  };

  const handleClearSearch = () => {
    setSearchInput('');
    setSearch('');
    setPage(1);
  };

  const handleLoadMore = () => {
    if (page < pages && !loadingMore) {
      const nextPage = page + 1;
      setPage(nextPage);
      loadEstimates(nextPage, search, true);
    }
  };

  const renderItem = ({ item }: { item: Estimate }) => (
    <TouchableOpacity
      style={styles.estimateCard}
      onPress={() => navigation.navigate('EstimateDetail', { id: item.id })}>
      <View style={styles.estimateInfo}>
        <Text style={styles.estimateType} numberOfLines={1}>
          {item.jobType}
        </Text>
        {item.details && (
          <Text style={styles.estimateDetails} numberOfLines={1}>
            {item.details}
          </Text>
        )}
        <View style={styles.metaRow}>
          <Text style={styles.estimateMeta}>{formatDate(item.createdAt)}</Text>
          <Text style={styles.estimateDot}>·</Text>
          <Text style={styles.estimateMeta}>{item.market}</Text>
          {item.clientName && (
            <>
              <Text style={styles.estimateDot}>·</Text>
              <Text style={styles.estimateMeta}>{item.clientName}</Text>
            </>
          )}
        </View>
      </View>
      <View style={styles.viewBadge}>
        <Text style={styles.viewBadgeText}>View →</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Estimate History</Text>
          <Text style={styles.subtitle}>{total} total estimates</Text>
        </View>
        <TouchableOpacity
          style={styles.newButton}
          onPress={() => navigation.navigate('NewEstimate')}>
          <Text style={styles.newButtonText}>+ New</Text>
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{error}</Text>
          <TouchableOpacity onPress={() => loadEstimates(page, search)}>
            <Text style={styles.errorRetryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search by job type or description..."
          placeholderTextColor={colors.textSubtle}
          value={searchInput}
          onChangeText={setSearchInput}
          onSubmitEditing={handleSearch}
          returnKeyType="search"
        />
        <TouchableOpacity style={styles.searchButton} onPress={handleSearch}>
          <Text style={styles.searchButtonText}>Search</Text>
        </TouchableOpacity>
        {search ? (
          <TouchableOpacity style={styles.clearButton} onPress={handleClearSearch}>
            <Text style={styles.clearButtonText}>Clear</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.green} />
        </View>
      ) : estimates.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyIcon}>{search ? '🔍' : '📋'}</Text>
          <Text style={styles.emptyTitle}>
            {search ? 'No estimates match your search' : 'No estimates yet'}
          </Text>
          {!search && (
            <TouchableOpacity
              style={styles.emptyButton}
              onPress={() => navigation.navigate('NewEstimate')}>
              <Text style={styles.emptyButtonText}>Create First Estimate</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <FlatList
          data={estimates}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.3}
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator
                color={colors.green}
                style={styles.loadingMore}
              />
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 28,
    fontWeight: '900',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  newButton: {
    backgroundColor: colors.green,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  newButtonText: {
    color: colors.bg,
    fontWeight: '700',
    fontSize: 14,
  },
  searchRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  searchInput: {
    flex: 1,
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    color: colors.textPrimary,
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  searchButton: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  searchButtonText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  clearButton: {
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  clearButtonText: {
    color: colors.textSubtle,
    fontSize: 14,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 40,
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
    fontSize: 15,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  estimateDetails: {
    color: colors.textSubtle,
    fontSize: 13,
    marginTop: 2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 4,
  },
  estimateMeta: {
    color: colors.textSubtle,
    fontSize: 12,
  },
  estimateDot: {
    color: colors.textSubtle,
    fontSize: 12,
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
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    color: colors.textMuted,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 16,
    textAlign: 'center',
  },
  emptyButton: {
    backgroundColor: colors.green,
    borderRadius: 10,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  emptyButtonText: {
    color: colors.bg,
    fontWeight: '700',
    fontSize: 14,
  },
  loadingMore: {
    paddingVertical: 16,
  },
  errorBanner: {
    backgroundColor: '#3a1c1c',
    borderRadius: 10,
    padding: 14,
    marginHorizontal: 20,
    marginBottom: 12,
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

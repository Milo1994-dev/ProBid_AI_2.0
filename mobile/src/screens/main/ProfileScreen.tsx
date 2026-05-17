import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  Switch,
  Linking,
} from 'react-native';
import { colors } from '../../theme/colors';
import { useAuth, isBiometricAvailable, getBiometricPreference, setBiometricPreference } from '../../contexts/AuthContext';
import { hapticLight } from '../../utils/haptics';
import type { ProfileScreenProps } from '../../navigation/types';

export default function ProfileScreen({ navigation }: ProfileScreenProps) {
  const { user, logout } = useAuth();
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);

  useEffect(() => {
    (async () => {
      const available = await isBiometricAvailable();
      setBiometricAvailable(available);
      if (available) {
        const pref = await getBiometricPreference();
        setBiometricEnabled(pref);
      }
    })();
  }, []);

  const handleBiometricToggle = async (value: boolean) => {
    hapticLight();
    await setBiometricPreference(value);
    setBiometricEnabled(value);
  };

  const handleLogout = () => {
    Alert.alert('Log Out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log Out',
        style: 'destructive',
        onPress: async () => {
          await logout();
        },
      },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title}>Profile</Text>

      <View style={styles.card}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {user?.email?.[0]?.toUpperCase() ?? '?'}
          </Text>
        </View>
        <Text style={styles.email}>{user?.email}</Text>
        <Text style={styles.userId}>ID: {user?.id?.substring(0, 8)}...</Text>
      </View>

      <View style={styles.menuCard}>
        <TouchableOpacity
          style={styles.menuItem}
          onPress={() => navigation.navigate('Billing')}>
          <Text style={styles.menuIcon}>💳</Text>
          <Text style={styles.menuText}>Billing & Plans</Text>
          <Text style={styles.menuArrow}>→</Text>
        </TouchableOpacity>

        <View style={styles.menuDivider} />

        <TouchableOpacity
          style={styles.menuItem}
          onPress={() => navigation.navigate('Tabs', { screen: 'History' })}>
          <Text style={styles.menuIcon}>📜</Text>
          <Text style={styles.menuText}>Estimate History</Text>
          <Text style={styles.menuArrow}>→</Text>
        </TouchableOpacity>

        <View style={styles.menuDivider} />

        <TouchableOpacity
          style={styles.menuItem}
          onPress={() => navigation.navigate('NotificationPreferences')}>
          <Text style={styles.menuIcon}>🔔</Text>
          <Text style={styles.menuText}>Notification Preferences</Text>
          <Text style={styles.menuArrow}>→</Text>
        </TouchableOpacity>

        <View style={styles.menuDivider} />

        <TouchableOpacity
          style={styles.menuItem}
          onPress={() => navigation.navigate('SavedLineItems', { mode: 'manage' })}>
          <Text style={styles.menuIcon}>📋</Text>
          <Text style={styles.menuText}>Saved Line Items</Text>
          <Text style={styles.menuArrow}>→</Text>
        </TouchableOpacity>

        <View style={styles.menuDivider} />

        <TouchableOpacity
          style={styles.menuItem}
          onPress={() => Linking.openURL('https://probid-core.replit.app/privacy')}>
          <Text style={styles.menuIcon}>🔒</Text>
          <Text style={styles.menuText}>Privacy Policy</Text>
          <Text style={styles.menuArrow}>→</Text>
        </TouchableOpacity>

        <View style={styles.menuDivider} />

        <TouchableOpacity
          style={styles.menuItem}
          onPress={() => Linking.openURL('https://probid-core.replit.app/terms')}>
          <Text style={styles.menuIcon}>📄</Text>
          <Text style={styles.menuText}>Terms of Service</Text>
          <Text style={styles.menuArrow}>→</Text>
        </TouchableOpacity>
      </View>

      {biometricAvailable && (
        <>
          <Text style={styles.sectionTitle}>Security</Text>
          <View style={styles.menuCard}>
            <View style={styles.menuItem}>
              <Text style={styles.menuIcon}>🔐</Text>
              <View style={styles.biometricTextContainer}>
                <Text style={styles.menuText}>Biometric Unlock</Text>
                <Text style={styles.biometricHint}>
                  Use Face ID or fingerprint to unlock the app
                </Text>
              </View>
              <Switch
                value={biometricEnabled}
                onValueChange={handleBiometricToggle}
                trackColor={{ false: colors.border, true: 'rgba(0, 230, 118, 0.4)' }}
                thumbColor={biometricEnabled ? colors.green : colors.textSubtle}
              />
            </View>
          </View>
        </>
      )}

      <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
        <Text style={styles.logoutText}>Log Out</Text>
      </TouchableOpacity>

      <Text style={styles.version}>ProBid AI v1.0.0</Text>
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
  title: {
    color: colors.textPrimary,
    fontSize: 28,
    fontWeight: '900',
    marginBottom: 24,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 24,
    alignItems: 'center',
    marginBottom: 16,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(0, 230, 118, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  avatarText: {
    color: colors.green,
    fontSize: 28,
    fontWeight: '800',
  },
  email: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  userId: {
    color: colors.textSubtle,
    fontSize: 12,
  },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 8,
  },
  menuCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 24,
    overflow: 'hidden',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  menuIcon: {
    fontSize: 20,
  },
  menuText: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '500',
    flex: 1,
  },
  menuArrow: {
    color: colors.textSubtle,
    fontSize: 16,
  },
  menuDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: 16,
  },
  biometricTextContainer: {
    flex: 1,
  },
  biometricHint: {
    color: colors.textSubtle,
    fontSize: 12,
    marginTop: 2,
  },
  logoutButton: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 24,
  },
  logoutText: {
    color: colors.red,
    fontSize: 16,
    fontWeight: '600',
  },
  version: {
    color: colors.textSubtle,
    fontSize: 12,
    textAlign: 'center',
  },
});

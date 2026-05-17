import React from 'react';
import { ActivityIndicator, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { useAuth } from '../contexts/AuthContext';
import type { AuthStackParamList, MainStackParamList, TabParamList, RootStackParamList } from './types';

import LoginScreen from '../screens/auth/LoginScreen';
import SignupScreen from '../screens/auth/SignupScreen';
import OTPVerifyScreen from '../screens/auth/OTPVerifyScreen';
import DashboardScreen from '../screens/main/DashboardScreen';
import NewEstimateScreen from '../screens/main/NewEstimateScreen';
import EstimateDetailScreen from '../screens/main/EstimateDetailScreen';
import HistoryScreen from '../screens/main/HistoryScreen';
import BillingScreen from '../screens/main/BillingScreen';
import ProfileScreen from '../screens/main/ProfileScreen';
import PhotoAnnotationScreen from '../screens/main/PhotoAnnotationScreen';
import NotificationPreferencesScreen from '../screens/main/NotificationPreferencesScreen';
import SavedLineItemsScreen from '../screens/main/SavedLineItemsScreen';
import OfflineBanner from '../components/OfflineBanner';

const DarkTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.green,
    background: colors.bg,
    card: colors.tabBar,
    text: colors.textPrimary,
    border: colors.border,
    notification: colors.green,
  },
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const MainStack = createNativeStackNavigator<MainStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();
const RootStack = createNativeStackNavigator<RootStackParamList>();

function AuthNavigator() {
  return (
    <AuthStack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
      }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="Signup" component={SignupScreen} />
      <AuthStack.Screen name="OTPVerify" component={OTPVerifyScreen} />
    </AuthStack.Navigator>
  );
}

function TabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.green,
        tabBarInactiveTintColor: colors.textSubtle,
        tabBarStyle: {
          backgroundColor: colors.tabBar,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          paddingBottom: 4,
          height: 56,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
        tabBarIcon: ({ focused, color }) => {
          let iconName: keyof typeof Ionicons.glyphMap = 'home';
          if (route.name === 'Dashboard') iconName = focused ? 'home' : 'home-outline';
          else if (route.name === 'History') iconName = focused ? 'time' : 'time-outline';
          else if (route.name === 'Profile') iconName = focused ? 'person' : 'person-outline';
          return <Ionicons name={iconName} size={22} color={color} />;
        },
      })}>
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="History" component={HistoryScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

function MainNavigator() {
  return (
    <MainStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.textPrimary,
        headerTitleStyle: { fontWeight: '700' },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
      }}>
      <MainStack.Screen
        name="Tabs"
        component={TabNavigator}
        options={{ headerShown: false }}
      />
      <MainStack.Screen
        name="NewEstimate"
        component={NewEstimateScreen}
        options={{ title: 'New Estimate' }}
      />
      <MainStack.Screen
        name="EstimateDetail"
        component={EstimateDetailScreen}
        options={{ title: 'Estimate Details' }}
      />
      <MainStack.Screen
        name="Billing"
        component={BillingScreen}
        options={{ title: 'Billing' }}
      />
      <MainStack.Screen
        name="PhotoAnnotation"
        component={PhotoAnnotationScreen}
        options={{ headerShown: false }}
      />
      <MainStack.Screen
        name="NotificationPreferences"
        component={NotificationPreferencesScreen}
        options={{ title: 'Notifications' }}
      />
      <MainStack.Screen
        name="SavedLineItems"
        component={SavedLineItemsScreen}
        options={{ title: 'Saved Line Items' }}
      />
    </MainStack.Navigator>
  );
}

function BiometricLockScreen() {
  const { unlockWithBiometric } = useAuth();

  const handleUnlock = async () => {
    await unlockWithBiometric();
  };

  return (
    <View style={styles.lockContainer}>
      <Text style={styles.lockIcon}>🔒</Text>
      <Text style={styles.lockTitle}>ProBid AI</Text>
      <Text style={styles.lockSubtitle}>Unlock to continue</Text>
      <TouchableOpacity style={styles.unlockButton} onPress={handleUnlock}>
        <Text style={styles.unlockButtonText}>Unlock with Biometrics</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function AppNavigator() {
  const { user, loading, authError, biometricLocked, refreshUser } = useAuth();

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.green} />
      </View>
    );
  }

  if (authError && !user) {
    return (
      <View style={styles.loadingContainer}>
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{authError}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={refreshUser}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (user && biometricLocked) {
    return <BiometricLockScreen />;
  }

  return (
    <NavigationContainer theme={DarkTheme}>
      <OfflineBanner />
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {user ? (
          <RootStack.Screen name="Main" component={MainNavigator} />
        ) : (
          <RootStack.Screen name="Auth" component={AuthNavigator} />
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorBox: {
    backgroundColor: '#3a1c1c',
    borderRadius: 12,
    padding: 24,
    marginHorizontal: 32,
    alignItems: 'center',
  },
  errorText: {
    color: '#ff6b6b',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 22,
  },
  retryButton: {
    backgroundColor: colors.green,
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  retryButtonText: {
    color: colors.bg,
    fontWeight: '700',
    fontSize: 15,
  },
  lockContainer: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  lockIcon: {
    fontSize: 56,
    marginBottom: 20,
  },
  lockTitle: {
    color: colors.textPrimary,
    fontSize: 28,
    fontWeight: '900',
    marginBottom: 8,
  },
  lockSubtitle: {
    color: colors.textMuted,
    fontSize: 16,
    marginBottom: 32,
  },
  unlockButton: {
    backgroundColor: colors.green,
    borderRadius: 14,
    paddingHorizontal: 32,
    paddingVertical: 16,
  },
  unlockButtonText: {
    color: colors.bg,
    fontSize: 16,
    fontWeight: '700',
  },
});

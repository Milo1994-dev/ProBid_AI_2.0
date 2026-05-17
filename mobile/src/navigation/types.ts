import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';

export type AuthStackParamList = {
  Login: undefined;
  Signup: undefined;
  OTPVerify: { email: string; mode: 'login' | 'signup' };
};

export type TabParamList = {
  Dashboard: undefined;
  History: undefined;
  Profile: undefined;
};

export type MainStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList>;
  NewEstimate: {
    templateJobType?: string;
    templateMarket?: string;
    templateDetails?: string;
    templateClientName?: string;
    templateClientEmail?: string;
    templateClientPhone?: string;
    annotatedImageUri?: string;
    annotatedImageIndex?: number;
    openTemplates?: boolean;
    insertPresetSummary?: string;
  } | undefined;
  EstimateDetail: { id: string };
  Billing: undefined;
  PhotoAnnotation: { imageUri: string; imageIndex: number };
  NotificationPreferences: undefined;
  SavedLineItems: { mode?: 'manage' | 'picker' } | undefined;
};

export type RootStackParamList = {
  Auth: NavigatorScreenParams<AuthStackParamList>;
  Main: NavigatorScreenParams<MainStackParamList>;
};

export type LoginScreenProps = NativeStackScreenProps<AuthStackParamList, 'Login'>;
export type SignupScreenProps = NativeStackScreenProps<AuthStackParamList, 'Signup'>;
export type OTPVerifyScreenProps = NativeStackScreenProps<AuthStackParamList, 'OTPVerify'>;

export type DashboardScreenProps = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, 'Dashboard'>,
  NativeStackScreenProps<MainStackParamList>
>;

export type HistoryScreenProps = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, 'History'>,
  NativeStackScreenProps<MainStackParamList>
>;

export type ProfileScreenProps = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, 'Profile'>,
  NativeStackScreenProps<MainStackParamList>
>;

export type NewEstimateScreenProps = NativeStackScreenProps<MainStackParamList, 'NewEstimate'>;
export type EstimateDetailScreenProps = NativeStackScreenProps<MainStackParamList, 'EstimateDetail'>;
export type BillingScreenProps = NativeStackScreenProps<MainStackParamList, 'Billing'>;
export type PhotoAnnotationScreenProps = NativeStackScreenProps<MainStackParamList, 'PhotoAnnotation'>;
export type NotificationPreferencesScreenProps = NativeStackScreenProps<MainStackParamList, 'NotificationPreferences'>;
export type SavedLineItemsScreenProps = NativeStackScreenProps<MainStackParamList, 'SavedLineItems'>;

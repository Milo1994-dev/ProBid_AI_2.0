import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { colors } from '../theme/colors';

const STEPS = [
  { label: 'Uploading photos', icon: '📤' },
  { label: 'Analyzing job site', icon: '🔍' },
  { label: 'Building line items', icon: '📋' },
  { label: 'Calculating costs', icon: '💰' },
];

const STEP_DURATION = 5000;

export default function StepProgressIndicator() {
  const [currentStep, setCurrentStep] = useState(0);
  const progressAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let cancelled = false;

    const animateStep = (step: number) => {
      if (step >= STEPS.length || cancelled) return;

      setCurrentStep(step);

      Animated.timing(progressAnim, {
        toValue: (step + 1) / STEPS.length,
        duration: STEP_DURATION,
        useNativeDriver: false,
      }).start(({ finished }) => {
        if (finished && !cancelled && step < STEPS.length - 1) {
          animateStep(step + 1);
        }
      });
    };

    animateStep(0);

    return () => {
      cancelled = true;
      progressAnim.stopAnimation();
    };
  }, []);

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <View style={styles.container}>
      <View style={styles.progressBarBg}>
        <Animated.View style={[styles.progressBarFill, { width: progressWidth }]} />
      </View>

      <View style={styles.stepsContainer}>
        {STEPS.map((step, index) => {
          const isActive = index === currentStep;
          const isComplete = index < currentStep;

          return (
            <View key={index} style={styles.stepRow}>
              <View
                style={[
                  styles.stepDot,
                  isComplete && styles.stepDotComplete,
                  isActive && styles.stepDotActive,
                ]}>
                {isComplete ? (
                  <Text style={styles.checkmark}>✓</Text>
                ) : (
                  <Text style={styles.stepIcon}>{step.icon}</Text>
                )}
              </View>
              <Text
                style={[
                  styles.stepLabel,
                  isActive && styles.stepLabelActive,
                  isComplete && styles.stepLabelComplete,
                ]}>
                {step.label}
                {isActive ? '...' : ''}
              </Text>
            </View>
          );
        })}
      </View>

      <Text style={styles.timeHint}>This usually takes 10-30 seconds</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(92, 107, 192, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(92, 107, 192, 0.25)',
    borderRadius: 16,
    padding: 18,
    marginBottom: 16,
  },
  progressBarBg: {
    height: 6,
    backgroundColor: 'rgba(92, 107, 192, 0.15)',
    borderRadius: 3,
    marginBottom: 16,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.indigo,
    borderRadius: 3,
  },
  stepsContainer: {
    gap: 12,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  stepDot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(92, 107, 192, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  stepDotActive: {
    backgroundColor: 'rgba(92, 107, 192, 0.25)',
    borderWidth: 2,
    borderColor: colors.indigo,
  },
  stepDotComplete: {
    backgroundColor: 'rgba(0, 230, 118, 0.2)',
  },
  checkmark: {
    color: colors.green,
    fontSize: 14,
    fontWeight: '800',
  },
  stepIcon: {
    fontSize: 14,
  },
  stepLabel: {
    color: colors.textSubtle,
    fontSize: 14,
    fontWeight: '500',
  },
  stepLabelActive: {
    color: colors.indigo,
    fontWeight: '700',
  },
  stepLabelComplete: {
    color: colors.green,
    fontWeight: '600',
  },
  timeHint: {
    color: colors.textSubtle,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 14,
  },
});

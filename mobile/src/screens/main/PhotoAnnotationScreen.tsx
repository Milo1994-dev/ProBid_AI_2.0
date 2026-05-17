import React, { useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  Dimensions,
  PanResponder,
  TextInput,
  Alert,
  Modal,
} from 'react-native';
import Svg, { Path, Circle, Line, Text as SvgText, G, Polygon } from 'react-native-svg';
import ViewShot from 'react-native-view-shot';
import { colors } from '../../theme/colors';
import type { PhotoAnnotationScreenProps } from '../../navigation/types';

type DrawMode = 'freehand' | 'circle' | 'arrow' | 'text';
type AnnotationColor = '#FF3B30' | '#FF9500' | '#FFCC00' | '#34C759' | '#007AFF' | '#FFFFFF';

interface FreehandAnnotation {
  type: 'freehand';
  path: string;
  color: AnnotationColor;
}

interface CircleAnnotation {
  type: 'circle';
  cx: number;
  cy: number;
  r: number;
  color: AnnotationColor;
}

interface ArrowAnnotation {
  type: 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: AnnotationColor;
}

interface TextAnnotation {
  type: 'text';
  x: number;
  y: number;
  text: string;
  color: AnnotationColor;
}

type Annotation = FreehandAnnotation | CircleAnnotation | ArrowAnnotation | TextAnnotation;

const COLORS: AnnotationColor[] = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#007AFF', '#FFFFFF'];
const SCREEN_WIDTH = Dimensions.get('window').width;

export default function PhotoAnnotationScreen({ route, navigation }: PhotoAnnotationScreenProps) {
  const { imageUri, imageIndex } = route.params;
  const [mode, setMode] = useState<DrawMode>('freehand');
  const [activeColor, setActiveColor] = useState<AnnotationColor>('#FF3B30');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [currentPath, setCurrentPath] = useState<string>('');
  const [shapeStart, setShapeStart] = useState<{ x: number; y: number } | null>(null);
  const [shapeEnd, setShapeEnd] = useState<{ x: number; y: number } | null>(null);
  const [textModalVisible, setTextModalVisible] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [textPosition, setTextPosition] = useState<{ x: number; y: number } | null>(null);
  const viewShotRef = useRef<ViewShot>(null);
  const [imageLayout, setImageLayout] = useState({ width: SCREEN_WIDTH, height: SCREEN_WIDTH });

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const colorRef = useRef(activeColor);
  colorRef.current = activeColor;
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;
  const shapeStartRef = useRef(shapeStart);
  shapeStartRef.current = shapeStart;
  const shapeEndRef = useRef(shapeEnd);
  shapeEndRef.current = shapeEnd;

  const onImageLayout = useCallback((event: { nativeEvent: { layout: { width: number; height: number } } }) => {
    const { width, height } = event.nativeEvent.layout;
    setImageLayout({ width, height });
  }, []);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          const { locationX, locationY } = evt.nativeEvent;
          const currentMode = modeRef.current;
          if (currentMode === 'freehand') {
            const p = `M${locationX},${locationY}`;
            currentPathRef.current = p;
            setCurrentPath(p);
          } else if (currentMode === 'circle' || currentMode === 'arrow') {
            const start = { x: locationX, y: locationY };
            shapeStartRef.current = start;
            shapeEndRef.current = start;
            setShapeStart(start);
            setShapeEnd(start);
          } else if (currentMode === 'text') {
            setTextPosition({ x: locationX, y: locationY });
            setTextInput('');
            setTextModalVisible(true);
          }
        },
        onPanResponderMove: (evt) => {
          const { locationX, locationY } = evt.nativeEvent;
          const currentMode = modeRef.current;
          if (currentMode === 'freehand') {
            setCurrentPath((prev) => {
              const next = `${prev} L${locationX},${locationY}`;
              currentPathRef.current = next;
              return next;
            });
          } else if (currentMode === 'circle' || currentMode === 'arrow') {
            const end = { x: locationX, y: locationY };
            shapeEndRef.current = end;
            setShapeEnd(end);
          }
        },
        onPanResponderRelease: () => {
          const currentMode = modeRef.current;
          const color = colorRef.current;
          if (currentMode === 'freehand') {
            const path = currentPathRef.current;
            if (path) {
              setAnnotations((prev) => [...prev, { type: 'freehand', path, color }]);
              currentPathRef.current = '';
              setCurrentPath('');
            }
          } else if (currentMode === 'circle') {
            const start = shapeStartRef.current;
            const end = shapeEndRef.current;
            if (start && end) {
              const cx = (start.x + end.x) / 2;
              const cy = (start.y + end.y) / 2;
              const r = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2)) / 2;
              if (r > 5) {
                setAnnotations((prev) => [...prev, { type: 'circle', cx, cy, r, color }]);
              }
            }
            shapeStartRef.current = null;
            shapeEndRef.current = null;
            setShapeStart(null);
            setShapeEnd(null);
          } else if (currentMode === 'arrow') {
            const start = shapeStartRef.current;
            const end = shapeEndRef.current;
            if (start && end) {
              const dist = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2));
              if (dist > 10) {
                setAnnotations((prev) => [...prev, { type: 'arrow', x1: start.x, y1: start.y, x2: end.x, y2: end.y, color }]);
              }
            }
            shapeStartRef.current = null;
            shapeEndRef.current = null;
            setShapeStart(null);
            setShapeEnd(null);
          }
        },
      }),
    [],
  );

  const handleAddText = () => {
    if (textInput.trim() && textPosition) {
      setAnnotations((prev) => [...prev, { type: 'text', x: textPosition.x, y: textPosition.y, text: textInput.trim(), color: activeColor }]);
    }
    setTextModalVisible(false);
    setTextInput('');
    setTextPosition(null);
  };

  const handleUndo = () => {
    setAnnotations((prev) => prev.slice(0, -1));
  };

  const handleClear = () => {
    Alert.alert('Clear All', 'Remove all annotations?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => setAnnotations([]) },
    ]);
  };

  const handleDone = async () => {
    try {
      if (viewShotRef.current?.capture) {
        const uri = await viewShotRef.current.capture();
        navigation.navigate('NewEstimate', { annotatedImageUri: uri, annotatedImageIndex: imageIndex });
      }
    } catch {
      Alert.alert('Error', 'Failed to save annotated image.');
    }
  };

  const handleCancel = () => {
    navigation.goBack();
  };

  const getArrowHeadPoints = (x1: number, y1: number, x2: number, y2: number): string => {
    const headLen = 12;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const a1x = x2 - headLen * Math.cos(angle - Math.PI / 6);
    const a1y = y2 - headLen * Math.sin(angle - Math.PI / 6);
    const a2x = x2 - headLen * Math.cos(angle + Math.PI / 6);
    const a2y = y2 - headLen * Math.sin(angle + Math.PI / 6);
    return `${x2},${y2} ${a1x},${a1y} ${a2x},${a2y}`;
  };

  const renderAnnotation = (ann: Annotation, i: number) => {
    switch (ann.type) {
      case 'freehand':
        return <Path key={i} d={ann.path} stroke={ann.color} strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
      case 'circle':
        return <Circle key={i} cx={ann.cx} cy={ann.cy} r={ann.r} stroke={ann.color} strokeWidth={3} fill="none" />;
      case 'arrow':
        return (
          <G key={i}>
            <Line x1={ann.x1} y1={ann.y1} x2={ann.x2} y2={ann.y2} stroke={ann.color} strokeWidth={3} />
            <Polygon points={getArrowHeadPoints(ann.x1, ann.y1, ann.x2, ann.y2)} fill={ann.color} />
          </G>
        );
      case 'text':
        return (
          <G key={i}>
            <SvgText x={ann.x} y={ann.y} fill={ann.color} fontSize={18} fontWeight="bold" stroke={colors.black} strokeWidth={0.5}>
              {ann.text}
            </SvgText>
          </G>
        );
    }
  };

  const renderLiveShape = () => {
    if (!shapeStart || !shapeEnd) return null;
    if (mode === 'circle') {
      const cx = (shapeStart.x + shapeEnd.x) / 2;
      const cy = (shapeStart.y + shapeEnd.y) / 2;
      const r = Math.sqrt(Math.pow(shapeEnd.x - shapeStart.x, 2) + Math.pow(shapeEnd.y - shapeStart.y, 2)) / 2;
      return <Circle cx={cx} cy={cy} r={r} stroke={activeColor} strokeWidth={3} fill="none" opacity={0.6} />;
    }
    if (mode === 'arrow') {
      return (
        <G>
          <Line x1={shapeStart.x} y1={shapeStart.y} x2={shapeEnd.x} y2={shapeEnd.y} stroke={activeColor} strokeWidth={3} opacity={0.6} />
          <Polygon points={getArrowHeadPoints(shapeStart.x, shapeStart.y, shapeEnd.x, shapeEnd.y)} fill={activeColor} opacity={0.6} />
        </G>
      );
    }
    return null;
  };

  const modes: { key: DrawMode; label: string; icon: string }[] = [
    { key: 'freehand', label: 'Draw', icon: '✏️' },
    { key: 'circle', label: 'Circle', icon: '⭕' },
    { key: 'arrow', label: 'Arrow', icon: '➡️' },
    { key: 'text', label: 'Text', icon: '🔤' },
  ];

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={handleCancel} style={styles.topBarButton}>
          <Text style={styles.topBarButtonText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.topBarTitle}>Annotate Photo</Text>
        <TouchableOpacity onPress={handleDone} style={[styles.topBarButton, styles.doneButton]}>
          <Text style={[styles.topBarButtonText, styles.doneButtonText]}>Done</Text>
        </TouchableOpacity>
      </View>

      <ViewShot ref={viewShotRef} options={{ format: 'jpg', quality: 0.9 }} style={styles.canvasContainer}>
        <View onLayout={onImageLayout} style={styles.imageWrapper}>
          <Image source={{ uri: imageUri }} style={styles.image} resizeMode="contain" />
          <View style={StyleSheet.absoluteFill} {...panResponder.panHandlers}>
            <Svg width={imageLayout.width} height={imageLayout.height} style={StyleSheet.absoluteFill}>
              {annotations.map(renderAnnotation)}
              {currentPath ? <Path d={currentPath} stroke={activeColor} strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.8} /> : null}
              {renderLiveShape()}
            </Svg>
          </View>
        </View>
      </ViewShot>

      <View style={styles.toolbar}>
        <View style={styles.modeRow}>
          {modes.map((m) => (
            <TouchableOpacity
              key={m.key}
              style={[styles.modePill, mode === m.key && styles.modePillActive]}
              onPress={() => setMode(m.key)}>
              <Text style={styles.modeIcon}>{m.icon}</Text>
              <Text style={[styles.modeLabel, mode === m.key && styles.modeLabelActive]}>{m.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.colorRow}>
          {COLORS.map((c) => (
            <TouchableOpacity
              key={c}
              style={[styles.colorDot, { backgroundColor: c }, activeColor === c && styles.colorDotActive]}
              onPress={() => setActiveColor(c)}
            />
          ))}
        </View>

        <View style={styles.actionRow}>
          <TouchableOpacity style={styles.actionButton} onPress={handleUndo} disabled={annotations.length === 0}>
            <Text style={[styles.actionButtonText, annotations.length === 0 && styles.actionButtonDisabled]}>Undo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionButton} onPress={handleClear} disabled={annotations.length === 0}>
            <Text style={[styles.actionButtonText, styles.actionButtonDestructive, annotations.length === 0 && styles.actionButtonDisabled]}>Clear All</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Modal visible={textModalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Add Text Label</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Enter label text..."
              placeholderTextColor={colors.textSubtle}
              value={textInput}
              onChangeText={setTextInput}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleAddText}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalCancelButton} onPress={() => { setTextModalVisible(false); setTextPosition(null); }}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalAddButton} onPress={handleAddText}>
                <Text style={styles.modalAddText}>Add</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.black,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 50,
    paddingBottom: 10,
    backgroundColor: colors.bg,
  },
  topBarButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  topBarButtonText: {
    color: colors.textMuted,
    fontSize: 16,
    fontWeight: '500',
  },
  topBarTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  doneButton: {
    backgroundColor: colors.green,
    borderRadius: 8,
  },
  doneButtonText: {
    color: colors.bg,
    fontWeight: '700',
  },
  canvasContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.black,
  },
  imageWrapper: {
    width: '100%',
    aspectRatio: 1,
    position: 'relative',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  toolbar: {
    backgroundColor: colors.bg,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 30,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  modeRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 12,
  },
  modePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  modePillActive: {
    backgroundColor: 'rgba(0, 230, 118, 0.15)',
    borderColor: colors.green,
  },
  modeIcon: {
    fontSize: 14,
  },
  modeLabel: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '500',
  },
  modeLabelActive: {
    color: colors.green,
    fontWeight: '700',
  },
  colorRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 12,
  },
  colorDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  colorDotActive: {
    borderColor: colors.white,
    borderWidth: 3,
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 20,
  },
  actionButton: {
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  actionButtonText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  actionButtonDestructive: {
    color: colors.red,
  },
  actionButtonDisabled: {
    opacity: 0.3,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 30,
  },
  modalContent: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 20,
    width: '100%',
    maxWidth: 340,
  },
  modalTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 14,
    textAlign: 'center',
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
  modalAddButton: {
    flex: 1,
    backgroundColor: colors.green,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalAddText: {
    color: colors.bg,
    fontSize: 16,
    fontWeight: '700',
  },
});

import React, { useState, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Dimensions,
  ScrollView, Animated,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const ONBOARDING_KEY = 'onboarding_completed_v1';

const { width: W } = Dimensions.get('window');

const SLIDES = [
  {
    image: require('../assets/onboarding1.png'),
    title: 'مراقب الكهرباء',
    subtitle: 'تتبّع الكهرباء في حيّك',
    body: 'يراقب التطبيق الشبكة الكهربائية عبر جهاز Growatt ويُنبّهك فوراً عند اشتغال الكهرباء أو طفوها — حتى لو كان الجهاز بعيداً عنك.',
    accent: '#38bdf8',
  },
  {
    image: require('../assets/onboarding2.png'),
    title: 'فارق حيّك الزمني',
    subtitle: 'خصّص توقعاتك لموقعك',
    body: 'يصل التيار إلى أحياء مختلفة في أوقات مختلفة. أخبرنا متى وصلت إليك الكهرباء آخر مرة، وسنحسب "فارق حيّك" لتحصل على جدول دقيق لمنطقتك.',
    accent: '#f59e0b',
  },
  {
    image: require('../assets/onboarding3.png'),
    title: 'شبكة المجتمع',
    subtitle: 'معاً نعرف الحقيقة',
    body: 'تابع الجيران الموثوقين وشارك تغييرات الكهرباء فور حدوثها. كلما تعاونتم، كلما دقّت التوقعات وانتفع الجميع.',
    accent: '#22c55e',
  },
];

export default function OnboardingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [activeIndex, setActiveIndex] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const goTo = (index: number) => {
    Animated.sequence([
      Animated.timing(fadeAnim, { toValue: 0, duration: 120, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start();
    scrollRef.current?.scrollTo({ x: index * W, animated: true });
    setActiveIndex(index);
  };

  const handleNext = () => {
    if (activeIndex < SLIDES.length - 1) {
      goTo(activeIndex + 1);
    } else {
      handleFinish();
    }
  };

  const handleFinish = async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
    router.replace('/login');
  };

  const slide = SLIDES[activeIndex];

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {/* Slide image area */}
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEnabled={false}
        style={styles.imageScroll}
      >
        {SLIDES.map((s, i) => (
          <Image
            key={i}
            source={s.image}
            style={styles.image}
            contentFit="cover"
            transition={200}
          />
        ))}
      </ScrollView>

      {/* Overlay gradient and content */}
      <View style={styles.overlay} pointerEvents="none" />

      {/* Skip */}
      <TouchableOpacity style={styles.skipBtn} onPress={handleFinish} activeOpacity={0.7}>
        <Text style={styles.skipText}>تخطي</Text>
      </TouchableOpacity>

      {/* Bottom card */}
      <Animated.View style={[styles.card, { opacity: fadeAnim }]}>
        {/* Accent bar */}
        <View style={[styles.accentBar, { backgroundColor: slide.accent }]} />

        <Text style={[styles.title, { color: slide.accent }]}>{slide.title}</Text>
        <Text style={styles.subtitle}>{slide.subtitle}</Text>
        <Text style={styles.body}>{slide.body}</Text>

        {/* Dot indicators */}
        <View style={styles.dots}>
          {SLIDES.map((_, i) => (
            <TouchableOpacity key={i} onPress={() => goTo(i)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <View
                style={[
                  styles.dot,
                  {
                    backgroundColor: i === activeIndex ? slide.accent : '#334155',
                    width: i === activeIndex ? 24 : 8,
                  },
                ]}
              />
            </TouchableOpacity>
          ))}
        </View>

        {/* CTA button */}
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: slide.accent }]}
          onPress={handleNext}
          activeOpacity={0.85}
        >
          <Text style={styles.btnText}>
            {activeIndex === SLIDES.length - 1 ? 'ابدأ الآن →' : 'التالي →'}
          </Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#060d1a' },
  imageScroll: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  image: { width: W, height: '100%' },
  overlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(6, 13, 26, 0.65)',
  },
  skipBtn: {
    position: 'absolute', top: 56, left: 20, zIndex: 10,
    backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 8,
  },
  skipText: { color: '#94a3b8', fontSize: 13, fontWeight: '600' },
  card: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: '#0f172a', borderTopLeftRadius: 32, borderTopRightRadius: 32,
    padding: 28, paddingBottom: 40,
    borderTopWidth: 1, borderColor: '#1e293b',
  },
  accentBar: { width: 48, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 24 },
  title: { fontSize: 26, fontWeight: '900', marginBottom: 6, textAlign: 'right' },
  subtitle: { color: '#94a3b8', fontSize: 14, fontWeight: '600', marginBottom: 14, textAlign: 'right' },
  body: { color: '#64748b', fontSize: 14, lineHeight: 24, textAlign: 'right', marginBottom: 24 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 24 },
  dot: { height: 8, borderRadius: 4 },
  btn: { borderRadius: 16, paddingVertical: 17, alignItems: 'center' },
  btnText: { color: '#0f172a', fontWeight: '900', fontSize: 16 },
});

import { Stack } from 'expo-router';
import { useAuth } from '../../contexts/AuthContext';
import { TouchableOpacity, Text, View } from 'react-native';
import { useUnreviewedConflictsCount } from '../../hooks/useResyncHistory';
import { AR } from '../../constants/arabic';

function ConflictsBadge() {
  const { count } = useUnreviewedConflictsCount();
  if (count === 0) return null;
  return (
    <View style={{ backgroundColor: '#f59e0b', borderRadius: 8, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, marginLeft: 4 }}>
      <Text style={{ color: '#000', fontSize: 9, fontWeight: '900' }}>{count}</Text>
    </View>
  );
}

export default function AdminLayout() {
  const { signOut } = useAuth();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#0f172a' },
        headerTintColor: '#e2e8f0',
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: '#0f172a' },
        headerLeft: () => (
          <TouchableOpacity onPress={signOut} style={{ marginLeft: 4 }}>
            <Text style={{ color: '#64748b', fontSize: 13 }}>{AR.signOut}</Text>
          </TouchableOpacity>
        ),
        headerRight: () => null,
      }}
    >
      <Stack.Screen name="index" options={{ title: AR.growattMonitor, headerShown: true }} />
      <Stack.Screen name="history" options={{ title: AR.powerHistory }} />
      <Stack.Screen name="predictions" options={{ title: AR.smartPredictions }} />
      <Stack.Screen
        name="settings"
        options={{
          title: AR.settings,
          headerTitle: () => (
            <View style={{ flexDirection: 'row-reverse', alignItems: 'center' }}>
              <Text style={{ color: '#e2e8f0', fontWeight: '700', fontSize: 17 }}>{AR.settings}</Text>
              <ConflictsBadge />
            </View>
          ),
        }}
      />
      <Stack.Screen name="conflicts" options={{ title: AR.conflictsTitle }} />
      <Stack.Screen name="accuracy" options={{ title: 'دقة التوقعات' }} />
      <Stack.Screen name="offset-analytics" options={{ title: 'تحليل الفوارق الزمنية' }} />
    </Stack>
  );
}

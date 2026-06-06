import { Stack } from 'expo-router';
import { useAuth } from '../../contexts/AuthContext';
import { TouchableOpacity, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useUnreviewedConflictsCount } from '../../hooks/useResyncHistory';

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
        headerRight: () => (
          <TouchableOpacity onPress={signOut} style={{ marginRight: 4 }}>
            <Text style={{ color: '#64748b', fontSize: 13 }}>Sign Out</Text>
          </TouchableOpacity>
        ),
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Grid Monitor', headerShown: true }} />
      <Stack.Screen name="history" options={{ title: 'Power History' }} />
      <Stack.Screen name="predictions" options={{ title: 'Smart Predictions' }} />
      <Stack.Screen
        name="settings"
        options={{
          title: 'Settings',
          headerTitle: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ color: '#e2e8f0', fontWeight: '700', fontSize: 17 }}>Settings</Text>
              <ConflictsBadge />
            </View>
          ),
        }}
      />
      <Stack.Screen name="conflicts" options={{ title: 'Community Conflicts' }} />
    </Stack>
  );
}

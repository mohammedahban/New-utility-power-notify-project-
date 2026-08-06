import { View, ActivityIndicator } from 'react-native';

// Root index route — the neutral landing screen shown while AuthGate
// determines the session and the user's role.
//
// Without this file expo-router resolved "/" to the first group route
// ("(admin)"), so on a cold start EVERY user briefly saw the admin dashboard
// (with its data) for a few seconds until AuthGate finished loading and
// redirected non-admin users to /(user). This screen renders the same splash
// as AuthGate and is replaced by AuthGate's centralized redirect:
//   • no session        → /login
//   • role === 'admin'  → /(admin)
//   • otherwise         → /(user)
export default function Index() {
  return (
    <View style={{ flex: 1, backgroundColor: '#060d1a', alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" color="#38bdf8" />
    </View>
  );
}

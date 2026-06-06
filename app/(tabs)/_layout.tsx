import { Redirect } from 'expo-router';

// This file handles the (tabs) group which is no longer used.
// All auth-based routing is handled by app/_layout.tsx AuthGate.
export default function TabsLayout() {
  return <Redirect href="/login" />;
}

/**
 * app/(admin)/_layout.tsx
 *
 * Route group layout for all admin/dev screens.
 * The (admin) group name does NOT appear in the URL — files here are
 * accessible at their filename directly (e.g. simulator.tsx → /simulator).
 *
 * Guard options (pick one):
 *   A) __DEV__ only  — simplest, strips the route from production bundles
 *   B) Auth check    — keep the route but require an admin session
 *
 * Current: option A (__DEV__ guard). Replace with your auth logic if you
 * want the simulator accessible in production for admin users.
 */
import { Redirect, Stack } from 'expo-router';

export default function AdminLayout() {
  // ── Dev guard ─────────────────────────────────────────────────────────────
  // In production builds __DEV__ is false, so non-dev users are redirected
  // to the app root and never see this route group at all.
  if (!__DEV__) {
    return <Redirect href="/" />;
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#0A0E12' },
        headerTintColor: '#E4E9EE',
        headerTitleStyle: { fontWeight: '700' },
      }}
    />
  );
}

import type { NavigationState, PartialState } from '@react-navigation/native';

type Cached = { accountId: string | null; state: NavigationState };

// A module variable is enough: Android recreates the activity on a font-size
// change, but the JS runtime and this module survive.
let cached: Cached | null = null;

type AnyState = NavigationState | PartialState<NavigationState>;

function stripRoute(state: AnyState, name: string): AnyState | undefined {
  const routes = (state.routes as any[]).flatMap((route) => {
    if (route.name === name) return [];
    if (!route.state) return [route];
    const inner = stripRoute(route.state, name);
    if (inner) return [{ ...route, state: inner }];
    const { state: _dropped, ...rest } = route;
    return [rest];
  });
  if (routes.length === 0) return undefined;
  const index = Math.min(state.index ?? routes.length - 1, routes.length - 1);
  return { ...state, routes, index } as AnyState;
}

export function withoutRoute(state: NavigationState, name: string): NavigationState | undefined {
  return stripRoute(state, name) as NavigationState | undefined;
}

export function rememberNavState(accountId: string | null, state: NavigationState | undefined): void {
  cached = state ? { accountId, state } : null;
}

export function restoredNavState(accountId: string | null): NavigationState | undefined {
  if (!cached || cached.accountId !== accountId) return undefined;
  // A half-written message is not restored, so Compose is dropped.
  return withoutRoute(cached.state, 'Compose');
}

export function clearNavState(): void {
  cached = null;
}

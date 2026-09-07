import { Navigate, Route, Routes } from 'react-router-dom';
import { useApp } from './state/AppContext';
import Onboarding from './screens/Onboarding';
import Auth from './screens/Auth';
import Today from './screens/Today';
import AddFood from './screens/AddFood';
import History from './screens/History';
import ProfileGoals from './screens/ProfileGoals';
import Import from './screens/Import';
import Welcome from './screens/Welcome';
import EditEntry from './screens/EditEntry';
import Recipes from './screens/Recipes';
import RecipeEditor from './screens/RecipeEditor';
import Trends from './screens/Trends';
import { AppShell } from './components/AppShell';
import { Spinner } from './components/ui';

/** Routing gate:
 *   no endpoint set        → Onboarding
 *   endpoint, signed out   → Auth
 *   signed in              → app shell (Today / AddFood / History / Profile / Import)
 *
 * The Router must wrap EVERYTHING — the gate switches which routes render,
 * it never renders <Routes> outside <BrowserRouter>.
 */
export function AppRoutes() {
  const { endpoint, userId, profile, latestWeight } = useApp();

  if (!endpoint) {
    return (
      <Routes>
        <Route path="*" element={<Onboarding />} />
      </Routes>
    );
  }
  if (!userId) {
    return (
      <Routes>
        <Route path="*" element={<Auth />} />
      </Routes>
    );
  }
  // First-run setup: while the profile is still bootstrapping, show a splash.
  // Returning null here left a blank screen for the length of the profile
  // fetch — and permanently, if that fetch failed.
  if (!profile) return <Bootstrapping />;
  const needsSetup =
    !profile.sex || !profile.height_cm || !profile.activity_level || latestWeight == null;
  if (needsSetup) {
    return (
      <Routes>
        <Route path="/welcome" element={<Welcome />} />
        <Route path="*" element={<Navigate to="/welcome" replace />} />
      </Routes>
    );
  }
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Today />} />
        <Route path="/today" element={<Today />} />
        <Route path="/add" element={<AddFood />} />
        <Route path="/history" element={<History />} />
        <Route path="/trends" element={<Trends />} />
        <Route path="/profile" element={<ProfileGoals />} />
        <Route path="/profile/import" element={<Import />} />
        <Route path="/recipes" element={<Recipes />} />
        <Route path="/recipes/new" element={<RecipeEditor />} />
        <Route path="/recipes/:id" element={<RecipeEditor />} />
        <Route path="/edit/:id" element={<EditEntry />} />
        <Route path="*" element={<Navigate to="/today" replace />} />
      </Routes>
    </AppShell>
  );
}


/** Cold-start splash. Deliberately branded rather than a bare spinner: on a
 *  slow or unreachable self-hosted server this is the whole screen. */
function Bootstrapping() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
      <div className="flex items-center gap-2 text-xs font-bold tracking-[.02em] text-text">
        <span className="h-2.5 w-2.5 rounded-[3px] bg-accent" />
        SAOLRIAN
      </div>
      <div className="flex items-center gap-2 text-sm text-text-muted">
        <Spinner /> Getting your profile…
      </div>
    </div>
  );
}

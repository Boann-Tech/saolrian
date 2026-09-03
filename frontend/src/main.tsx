import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './state/AppContext';
import Onboarding from './screens/Onboarding';
import Auth from './screens/Auth';
import Today from './screens/Today';
import AddFood from './screens/AddFood';
import History from './screens/History';
import ProfileGoals from './screens/ProfileGoals';
import Import from './screens/Import';
import Welcome from './screens/Welcome';
import { AppShell } from './components/AppShell';
import './styles/tokens.css';
import './styles/app.css';

/** Routing gate:
 *   no endpoint set        → Onboarding
 *   endpoint, signed out   → Auth
 *   signed in              → app shell (Today / AddFood / History / Profile / Import)
 *
 * The Router must wrap EVERYTHING — the gate switches which routes render,
 * it never renders <Routes> outside <BrowserRouter>.
 */
function AppRoutes() {
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
  // First-run setup: whiler the profile is still bootstrapping, show no UI;
  // once loaded, if key setup fields are missing, route to the wizard.
  if (!profile) return null;
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
        <Route path="/profile" element={<ProfileGoals />} />
        <Route path="/profile/import" element={<Import />} />
        <Route path="*" element={<Navigate to="/today" replace />} />
      </Routes>
    </AppShell>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProvider>
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppProvider } from './state/AppContext';
import { AppRoutes } from './AppRoutes';
import { ToastProvider } from './components/ui';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <ToastProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ToastProvider>
    </AppProvider>
  </StrictMode>,
);

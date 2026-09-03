import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// globals: false means @testing-library/react cannot auto-register its
// afterEach(cleanup); do it here so each test starts with a fresh DOM.
afterEach(cleanup);

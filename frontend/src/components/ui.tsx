/* Compatibility shim: the primitive layer now lives in ./ui/.
   Existing `import { X } from '../components/ui'` paths keep working.
   Note: the explicit `/index` is required because this file (`ui.tsx`) is a
   sibling of the `ui/` folder, so a bare `./ui` specifier would resolve back
   to this file. */
export * from './ui/index';

import { setActiveMaskConfig } from '../../src/mask/active-mask.js';
import { SUPPORTED_MASK_TYPES } from '../../src/types/index.js';

// Importing this turns every mask on for the test file (modules are per file); the product default is off.
setActiveMaskConfig({ mode: 'all', types: [...SUPPORTED_MASK_TYPES], replacementMode: 'placeholder' });

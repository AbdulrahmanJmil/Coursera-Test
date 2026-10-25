// Provider registry. To add a provider, implement listModels() and generate()
// with the same signatures and error codes as gemini.js and register it here.
import * as gemini from './gemini.js';

export const PROVIDERS = { [gemini.id]: gemini };

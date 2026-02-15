import 'dotenv/config';
import { setupEventListeners } from '../services/listeners.js';

let apiRuntimeInitialized = false;

function ensureBigIntJsonSerialization(): void {
  const proto = BigInt.prototype as unknown as { toJSON?: () => string };

  if (typeof proto.toJSON === 'function') {
    return;
  }

  // @ts-ignore - BigInt.prototype.toJSON is not in the standard lib
  BigInt.prototype.toJSON = function() {
    return this.toString();
  };
}

export function initializeApiRuntime(): void {
  if (apiRuntimeInitialized) {
    return;
  }

  ensureBigIntJsonSerialization();
  setupEventListeners();
  apiRuntimeInitialized = true;
}

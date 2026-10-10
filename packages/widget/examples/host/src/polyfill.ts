// Imported first: web3.js and the SDK expect a global Buffer in the browser.
import { Buffer } from 'buffer/';
(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;

// WebSocket polyfill for Node < 22.
// Must be the FIRST import in every fetcher entrypoint so globalThis.WebSocket
// is set before @supabase/supabase-js is evaluated.
import { WebSocket } from 'ws';
if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket;

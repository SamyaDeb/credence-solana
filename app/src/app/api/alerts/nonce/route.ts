// nonce: see ../_lib/alerts.ts (Friday alerts, C4a.2).
import { handleAlerts } from '../_lib/alerts';
import { alertsDeps } from '../_lib/deps';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = (req: Request) => handleAlerts(req, 'nonce', alertsDeps);

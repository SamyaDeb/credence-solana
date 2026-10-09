// actions.json (Solana Actions spec v2.4): maps the in-app Blink page and the Action API paths. Served with the Action
// headers (CORS *) as the spec requires; only this file and /api/actions/* carry `Access-Control-Allow-Origin: *`.
import type { ActionsJson } from '@solana/actions-spec';
import { actionJson, preflight } from '@/lib/actions/spec';

const RULES: ActionsJson = {
  rules: [
    { pathPattern: '/app/protect', apiPath: '/api/actions/protect' },
    { pathPattern: '/api/actions/**', apiPath: '/api/actions/**' },
  ],
};

export const dynamic = 'force-static';
export const GET = async () => actionJson(RULES);
export const OPTIONS = async () => preflight();

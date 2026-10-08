// GET: is the fork up, and is credence_core deployed and loaded on it (Config account)? Used by the header.
import { PROGRAM_ID, pdas } from '@/lib/credence';
import { FORK_RPC, fail, getAccount, json, rpc } from '@/lib/server/fork';

export async function GET() {
  try {
    const [slot, prog, cfg] = await Promise.all([rpc<number>('getSlot'), getAccount(PROGRAM_ID.toBase58()), getAccount(pdas.config().toBase58())]);
    const local = /127\.0\.0\.1|localhost/.test(FORK_RPC);
    return json({ ok: true, slot, programDeployed: !!prog, configLoaded: !!cfg, local });
  } catch (e) {
    return fail(e, 503);
  }
}

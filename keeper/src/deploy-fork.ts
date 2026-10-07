// Deploys target/deploy/credence_core.so onto the surfpool fork (surfnet_writeProgram), upgrade authority = admin.
import { connect, log } from './chain.js';
import { deployProgram } from './fork.js';

const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
const bytes = await deployProgram(c, c.payer.publicKey.toBase58());
log(`credence_core deployed on the fork (${bytes} bytes)`);

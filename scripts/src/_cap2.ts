import { address, createSolanaRpc, getBase64Encoder } from '@solana/kit';
import { Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';
const b64 = getBase64Encoder();
const rpc = createSolanaRpc('http://127.0.0.1:8909');
const a = await rpc.getAccountInfo(address('97zoywd8mPZsGTg8q1wdD2Wgkdrs2tqusp1Qqcxbyj7E'), { encoding: 'base64' }).send();
const r = Reserve.decode(Buffer.from(b64.encode(a.value!.data[0] as never)));
console.log('currentTotal', r.config.debtWithdrawalCap.currentTotal.toString(), 'start', r.config.debtWithdrawalCap.lastIntervalStartTimestamp.toString());

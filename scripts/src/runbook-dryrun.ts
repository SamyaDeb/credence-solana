// Dry run of docs/mainnet-runbook.md on a fresh mainnet fork (W6). Every step is the real tool or instruction the
// runbook names, against the fork instead of mainnet; nothing here ever talks to mainnet except surfpool's lazy reads.
//
//   1. deploy: target/deploy/credence_core.so at the program id, deployer = upgrade authority (mainnet: `solana program
//      deploy`; the fork takes the bytes by cheatcode, labelled)
//   2. hash: the deployed program's executable hash = the local build's (`solana-verify get-program-hash` /
//      `get-executable-hash`); the verifiable build hash in the README is checked separately (it needs Docker)
//   3. multisig: a 2-of-3 Squads v4 multisig (the mainnet program, cloned by the fork); its vault takes the upgrade
//      authority (`solana program set-upgrade-authority`)
//   4. data: config, assets, sets, calendar, vault, backstop, yield reserve (scripts/src/load-onchain.ts), deployer admin
//   5. admin handover: propose_admin(vault) by the deployer, accept_admin as a multisig vault transaction (2 approvals)
//   6. caps: set_params (u_max 10%, max asset share 25%, fee 0) and set_backstop_params (5% share) through the
//      multisig; guardian and keeper become their own keys
//   7. guardian drill: the guardian pauses; a deposit is refused (Paused); the deployer can no longer unpause; the
//      multisig unpauses
//   8. keeper: one keeper pass with the keeper key (opens the coming weekends)
//   9. monitor: scripts/src/monitor.ts checks pass, and flag a pause while paused
//  10. upgrade drill: a buffer written by the deployer, its authority set to the vault, the upgrade executed by the
//      multisig; the executable hash is unchanged (same build)
// Writes data/runbook/dryrun-<date>.json. Run by scripts/runbook-dryrun.sh (which starts and stops the fork).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
import * as multisig from '@sqds/multisig';
import { ROOT, connect, keypair, pdas, ticker8 } from './lib/credence.js';
import { checks } from './monitor.js';

const { web3, BN } = anchor;
type Kp = InstanceType<typeof web3.Keypair>;
type Pk = InstanceType<typeof web3.PublicKey>;
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const LOADER = new web3.PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const PROGRAM_KEYPAIR = process.env.PROGRAM_KEYPAIR ?? join(ROOT, 'target/deploy/credence_core-keypair.json');
const DEPLOYER = `${homedir()}/.config/solana/id.json`;
const TOKEN = new web3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new web3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
async function surfnet(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = (await r.json()) as { error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
}
const steps: { step: string; ok: boolean; detail: string }[] = [];
const simulated: string[] = [];
const wad = (x: number) => new BN((BigInt(Math.round(x * 1e9)) * 10n ** 9n).toString());

function solana(args: string[]) {
  return execFileSync('solana', [...args, '-u', RPC, '--keypair', DEPLOYER], { encoding: 'utf8' }).trim();
}
function step(name: string, ok: boolean, detail: string) {
  steps.push({ step: name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) throw new Error(`${name} failed`);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function main() {
  const { conn, program, wallet } = connect(RPC, DEPLOYER);
  const m = program.methods as any;
  const deployer = wallet.payer as Kp;
  const programId = program.programId;
  const airdrop = async (k: Pk, sol = 10) => conn.confirmTransaction(await conn.requestAirdrop(k, sol * 1e9), 'confirmed');
  await airdrop(deployer.publicKey, 100);

  // 1. Deploy with the real loader, at the declared id: needs that id's keypair (the owner's; a clone's `anchor build`
  // generates another one). Point PROGRAM_KEYPAIR at it.
  // The fork takes the bytes by cheatcode at the declared id, which needs the id and the authority, not the id's secret key.
  // With the owner's keypair at PROGRAM_KEYPAIR it is checked against the id; without it the dry run says so.
  try {
    const pk = keypair(PROGRAM_KEYPAIR).publicKey;
    if (!pk.equals(programId)) simulated.push(`the program id's keypair was not available (the build left ${pk.toBase58()}, not ${programId.toBase58()}): the fork writes the program at the declared id by cheatcode, which needs no secret key; on mainnet the deployer needs the id's keypair`);
  } catch { simulated.push('no program keypair file: the fork writes the program at the declared id by cheatcode; on mainnet the deployer needs the id\'s keypair'); }
  // 1. Deploy. On the fork the bytes go in through surfpool's writeProgram cheatcode: `solana program deploy` sends
  // ~2,400 write transactions and surfpool drops them ("Blockhash not found"). The result is the same upgradeable-loader
  // program (program + program data accounts, upgrade authority = the deployer); on mainnet the runbook uses the CLI.
  const so = join(ROOT, 'target/deploy/credence_core.so');
  const elf = readFileSync(so);
  for (let off = 0; off < elf.length; off += 512 * 1024) {
    await surfnet('surfnet_writeProgram', [programId.toBase58(), elf.subarray(off, off + 512 * 1024).toString('hex'), off, deployer.publicKey.toBase58()]);
  }
  const shown0 = solana(['program', 'show', programId.toBase58()]);
  step('1 deploy', shown0.includes(deployer.publicKey.toBase58()), `upgradeable program ${programId.toBase58()}, upgrade authority the deployer (bytes written by cheatcode on the fork)`);
  simulated.push('the program bytes and the upgrade buffer were written with surfpool cheatcodes (surfnet_writeProgram, surfnet_setAccount) instead of `solana program deploy` / `write-buffer`, which surfpool cannot take (~2,400 write transactions); the authority changes and the upgrade itself are real loader instructions');

  // 2. The deployed executable equals the local build. The program data account holds the ELF after a 45-byte header,
  // padded with zeros; the hash is over the ELF without the padding (as solana-verify computes it).
  const pdata = web3.PublicKey.findProgramAddressSync([programId.toBuffer()], LOADER)[0];
  const local = elf;
  const onchain = (await conn.getAccountInfo(pdata))!.data.subarray(45);
  const trimmed = onchain.subarray(0, local.length);
  step('2 hash', sha(trimmed) === sha(local) && onchain.subarray(local.length).every((x) => x === 0), `executable sha256 ${sha(local)}`);

  // 3. A 2-of-3 Squads v4 multisig; its vault takes the upgrade authority.
  const members = [web3.Keypair.generate(), web3.Keypair.generate(), web3.Keypair.generate()];
  for (const k of members) await airdrop(k.publicKey);
  const createKey = web3.Keypair.generate();
  const [msPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [vault] = multisig.getVaultPda({ multisigPda: msPda, index: 0 });
  const [programConfig] = multisig.getProgramConfigPda({});
  const pc = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, programConfig);
  await conn.confirmTransaction(await multisig.rpc.multisigCreateV2({
    connection: conn, treasury: pc.treasury, createKey, creator: members[0], multisigPda: msPda, configAuthority: null, threshold: 2,
    members: members.map((k) => ({ key: k.publicKey, permissions: multisig.types.Permissions.all() })), timeLock: 0, rentCollector: null,
  }), 'confirmed');
  await airdrop(vault, 5);
  solana(['program', 'set-upgrade-authority', programId.toBase58(), '--new-upgrade-authority', vault.toBase58(), '--skip-new-upgrade-authority-signer-check']);
  const shown = solana(['program', 'show', programId.toBase58()]);
  step('3 multisig', shown.includes(vault.toBase58()), `Squads v4 2-of-3 ${msPda.toBase58()}, vault ${vault.toBase58()} is the upgrade authority`);

  /** One multisig vault transaction: create, propose, two approvals, execute. */
  let index = 0n;
  const viaMultisig = async (what: string, ixs: InstanceType<typeof web3.TransactionInstruction>[]) => {
    index += 1n;
    const message = new web3.TransactionMessage({ payerKey: vault, recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: ixs });
    const [a, b] = members;
    await conn.confirmTransaction(await multisig.rpc.vaultTransactionCreate({ connection: conn, feePayer: a, multisigPda: msPda, transactionIndex: index, creator: a.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: message }), 'confirmed');
    await conn.confirmTransaction(await multisig.rpc.proposalCreate({ connection: conn, feePayer: a, creator: a, multisigPda: msPda, transactionIndex: index }), 'confirmed');
    for (const k of [a, b]) await conn.confirmTransaction(await multisig.rpc.proposalApprove({ connection: conn, feePayer: k, member: k, multisigPda: msPda, transactionIndex: index }), 'confirmed');
    const sig = await multisig.rpc.vaultTransactionExecute({ connection: conn, feePayer: a, multisigPda: msPda, transactionIndex: index, member: a.publicKey });
    const r = await conn.confirmTransaction(sig, 'confirmed');
    if (r.value.err) throw new Error(`${what}: ${JSON.stringify(r.value.err)}`);
    return sig;
  };

  // 4. Data, the deployer as admin (as for a first deployment).
  execFileSync('pnpm', ['-s', 'tsx', 'src/load-onchain.ts'], { cwd: join(ROOT, 'scripts'), stdio: 'inherit', env: { ...process.env, RPC_URL: RPC } });
  step('4 data', !!(await conn.getAccountInfo(pdas.config())), 'config, assets, sets, gap factors, calendar, vault, backstop, yield reserve loaded and hash-checked');

  // 5. Admin handover to the multisig's vault.
  await m.proposeAdmin(vault).accountsPartial({ admin: deployer.publicKey, config: pdas.config() }).rpc();
  await viaMultisig('accept_admin', [await m.acceptAdmin().accountsPartial({ newAdmin: vault, config: pdas.config() }).instruction()]);
  const cfg = await (program.account as any).config.fetch(pdas.config());
  step('5 admin', cfg.admin.equals(vault), `config.admin = the multisig vault ${vault.toBase58()}`);

  // 6. Launch caps and roles through the multisig.
  const guardian = web3.Keypair.generate(), keeper = web3.Keypair.generate();
  await airdrop(guardian.publicKey); await airdrop(keeper.publicKey);
  const { admin: _a, usdcMint: _u, paused: _p, bump: _b, pendingAdmin: _pa, ...rest } = cfg;
  const params = { ...rest, guardian: guardian.publicKey, keeper: keeper.publicKey, uMaxWad: wad(0.1), maxAssetShareWad: wad(0.25), feeBps: 0 };
  const pool = await (program.account as any).backstopPool.fetch(pdas.backstop());
  const { spent: _s, salesProceeds: _sp, realizedPnl: _r, liquidations: _l, fills: _f, bump: _pb, ...bparams } = pool;
  await viaMultisig('caps', [
    await m.setParams(params).accountsPartial({ admin: vault, config: pdas.config() }).instruction(),
    await m.setBackstopParams({ ...bparams, maxShareWad: wad(0.05) }).accountsPartial({ admin: vault, config: pdas.config(), pool: pdas.backstop() }).instruction(),
  ]);
  const c2 = await (program.account as any).config.fetch(pdas.config());
  step('6 caps', c2.uMaxWad.toString() === wad(0.1).toString() && c2.guardian.equals(guardian.publicKey) && c2.keeper.equals(keeper.publicKey),
    'u_max 10%, max asset share 25%, backstop share 5%; guardian and keeper are their own keys');

  // 6b. D3 testnet hedge caps through the multisig, and who may touch them. Research feature: launch with the hedge book
  // never opened (the keeper only opens it with HEDGE_ENABLE), the caps small, the guardian able to void a report.
  const hedgeCfg = web3.PublicKey.findProgramAddressSync([Buffer.from('hedgecfg')], programId)[0];
  const hedgeParams = { marginCapBps: 100, pnlCapBps: 50, maxLeverage: 2, delaySecs: 86_400, expirySecs: 3 * 86_400, returnTolWad: wad(0.02) };
  await viaMultisig('init_hedge_config', [await m.initHedgeConfig(hedgeParams).accountsPartial({ admin: vault, config: pdas.config(), hedgeConfig: hedgeCfg }).instruction()]);
  let keeperDenied = '', guardianDenied = '';
  try { await m.setHedgeConfig({ ...hedgeParams, marginCapBps: 1000 }).accountsPartial({ admin: keeper.publicKey, config: pdas.config(), hedgeConfig: hedgeCfg }).signers([keeper]).rpc(); } catch (e) { keeperDenied = String((e as Error).message); }
  try { await m.setHedgeConfig({ ...hedgeParams, marginCapBps: 1000 }).accountsPartial({ admin: guardian.publicKey, config: pdas.config(), hedgeConfig: hedgeCfg }).signers([guardian]).rpc(); } catch (e) { guardianDenied = String((e as Error).message); }
  const hc = await (program.account as any).hedgeConfig.fetch(hedgeCfg);
  step('6b hedge caps', hc.marginCapBps === 100 && hc.pnlCapBps === 50 && hc.maxLeverage === 2 && /Unauthorized/.test(keeperDenied) && /Unauthorized/.test(guardianDenied),
    'D3 hedge caps set through the multisig (margin 1%, P&L 0.5%, leverage 2, challenge delay 24 h, expiry 3 d, return tolerance 2%); the keeper and guardian keys cannot change them');

  // 6c. D2 gap oracle: the admin (the multisig) creates each asset's feed; the keeper then refreshes it (update_gap_feed).
  // Gap tokens are a research prototype and are not offered; the feed is what the Gap Oracle (M2) publishes.
  const feedPda = (t: string) => web3.PublicKey.findProgramAddressSync([Buffer.from('feed'), Buffer.from(ticker8(t))], programId)[0];
  await viaMultisig('init_gap_feed', [await m.initGapFeed(ticker8('SPYx'), 150, 3600).accountsPartial({ admin: vault, config: pdas.config(), asset: pdas.asset('SPYx'), feed: feedPda('SPYx') }).instruction()]);
  await viaMultisig('set_gap_feed_params', [await m.setGapFeedParams(ticker8('SPYx'), 300, 7200).accountsPartial({ admin: vault, config: pdas.config(), feed: feedPda('SPYx') }).instruction()]);
  const feed = await (program.account as any).gapFeed.fetch(feedPda('SPYx'));
  step('6c gap feed', feed.minUpdateSlots === 300 && feed.maxInputAgeSecs === 7200, 'D2 SPYx gap feed created and tuned through the multisig (min 300 slots between updates, inputs at most 2 h old)');

  // 7. Guardian drill.
  await m.setPaused(true).accountsPartial({ authority: guardian.publicKey, config: pdas.config() }).signers([guardian]).rpc();
  const lp = web3.Keypair.generate();
  await airdrop(lp.publicKey);
  const USDC = new web3.PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  await surfnet('surfnet_setTokenAccount', [lp.publicKey.toBase58(), USDC.toBase58(), { amount: 10_000_000_000 }]); // fork cheatcode
  const ataOf = (o: Pk, mint: Pk) => web3.PublicKey.findProgramAddressSync([o.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];
  const createShares = new web3.TransactionInstruction({ programId: ATA, data: Buffer.from([1]), keys: [
    { pubkey: lp.publicKey, isSigner: true, isWritable: true }, { pubkey: ataOf(lp.publicKey, pdas.shares()), isSigner: false, isWritable: true },
    { pubkey: lp.publicKey, isSigner: false, isWritable: false }, { pubkey: pdas.shares(), isSigner: false, isWritable: false },
    { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN, isSigner: false, isWritable: false }] });
  let refused = '';
  try {
    await m.deposit(new BN(1_000_000_000)).accountsPartial({ depositor: lp.publicKey, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(),
      depositorUsdc: ataOf(lp.publicKey, USDC), depositorShares: ataOf(lp.publicKey, pdas.shares()), shareEscrow: pdas.shareEscrow() })
      .preInstructions([createShares]).signers([lp]).rpc();
  } catch (e) { refused = String((e as Error).message); }
  const monitorPaused = await checks(conn, program);
  let oldAdmin = '';
  try { await m.setPaused(false).accountsPartial({ authority: deployer.publicKey, config: pdas.config() }).rpc(); } catch (e) { oldAdmin = String((e as Error).message); }
  await viaMultisig('unpause', [await m.setPaused(false).accountsPartial({ authority: vault, config: pdas.config() }).instruction()]);
  const c3 = await (program.account as any).config.fetch(pdas.config());
  step('7 guardian', /Paused/.test(refused) && /Unauthorized/.test(oldAdmin) && c3.paused === false && monitorPaused.some((x) => x.level === 'alert' && /paused/i.test(x.what)),
    'guardian paused; risk-increasing calls refused; the monitor alerted; the old admin could not unpause; the multisig did');

  // 8. One keeper pass with the keeper's key.
  const kpath = join(ROOT, '.fork/runbook-keeper.json');
  mkdirSync(join(ROOT, '.fork'), { recursive: true });
  writeFileSync(kpath, JSON.stringify([...keeper.secretKey]));
  execFileSync('pnpm', ['-s', 'tsx', 'src/index.ts', '--once'], { cwd: join(ROOT, 'keeper'), stdio: 'inherit', env: { ...process.env, RPC_URL: RPC, KEEPER_WALLET: kpath } });
  const epochs = await (program.account as any).epoch.all();
  step('8 keeper', epochs.length > 0, `keeper pass with its own key: ${epochs.length} epochs open`);

  // 9. Monitoring.
  const report = await checks(conn, program);
  step('9 monitor', report.every((x) => x.level !== 'alert'), report.map((x) => `${x.level} ${x.what}`).join('; '));

  // 10. Upgrade through the multisig.
  const buffer = web3.Keypair.generate();
  const bpath = join(ROOT, '.fork/runbook-buffer.json');
  writeFileSync(bpath, JSON.stringify([...buffer.secretKey]));
  // The buffer as `write-buffer` + `set-buffer-authority` leave it: UpgradeableLoaderState::Buffer { authority: Some(vault) }
  // (u32 tag 1, option 1, 32-byte key) and the ELF (written by cheatcode on the fork, see step 1).
  const bufData = Buffer.concat([Buffer.from([1, 0, 0, 0, 1]), vault.toBuffer(), elf]);
  await surfnet('surfnet_setAccount', [buffer.publicKey.toBase58(), { lamports: await conn.getMinimumBalanceForRentExemption(bufData.length), data: bufData.toString('hex'), owner: LOADER.toBase58(), executable: false }]);
  void bpath;
  const upgrade = new web3.TransactionInstruction({
    programId: LOADER, data: Buffer.from([3, 0, 0, 0]),
    keys: [
      { pubkey: pdata, isSigner: false, isWritable: true }, { pubkey: programId, isSigner: false, isWritable: true },
      { pubkey: buffer.publicKey, isSigner: false, isWritable: true }, { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, { pubkey: web3.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: true, isWritable: false },
    ],
  });
  await viaMultisig('upgrade', [upgrade]);
  const after = (await conn.getAccountInfo(pdata))!.data.subarray(45, 45 + local.length);
  step('10 upgrade', sha(after) === sha(local), 'upgraded from a buffer by a multisig vault transaction; executable hash unchanged');

  const out = { ranAt: new Date().toISOString(), rpc: 'local surfpool fork', programId: programId.toBase58(), executableSha256: sha(local),
    multisig: msPda.toBase58(), vault: vault.toBase58(), steps,
    simulated: [...simulated, 'a fresh surfpool fork of mainnet (clock, SOL airdrops)', 'fresh keys for the multisig members, the guardian and the keeper (mainnet: hardware wallets held by different people)'] };
  mkdirSync(join(ROOT, 'data/runbook'), { recursive: true });
  writeFileSync(join(ROOT, `data/runbook/dryrun-${out.ranAt.slice(0, 10)}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(`dry run: ${steps.filter((x) => x.ok).length}/${steps.length} steps OK`);
}

main().catch((e) => { console.error(String((e as Error)?.message ?? e).replace(/api-key=[^&\s"]+/g, 'api-key=***')); process.exit(1); });

import * as fs from "fs";
import anchor from "@project-serum/anchor";
const { Program, Provider, web3, BN } = anchor;
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import * as splToken from "@solana/spl-token";
import * as crypto from "crypto";

// IDL 파일 경로 (프로젝트에 맞게 조정)
const idlPath = `${process.cwd()}/target/idl/treasure_vault.json`;
// IDL 파일을 문자열로 읽어온 후, "pubkey"를 "publicKey"로 치환
const idlRaw = fs.readFileSync(idlPath, "utf8");
const idlFixed = JSON.parse(idlRaw.replace(/"pubkey"/g, '"publicKey"'));
// Program ID는 실제 배포된 프로그램의 ID로 설정
const programId = new PublicKey("G8RBzoNGqmAWvhLUTpJyVhzMWCtAXk3nrBoC7Q2MEeit");

describe("treasure_vault", () => {
  const provider: Provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  
  // workspace 대신 직접 Program 객체 생성 (수정된 IDL 사용)
  const program = new Program(idlFixed, programId);

  // 테스트에서 사용할 계정 및 변수 설정
  const hider = web3.Keypair.generate();
  const claimer = web3.Keypair.generate();

  let vaultPda: PublicKey, vaultBump: number;
  let feeAccountPda: PublicKey, feeBump: number;
  let mint: splToken.Token;
  let assetAccount: PublicKey;

  const password = "secret_password";
  const wrongPassword = "wrong_password";
  const hashBuffer = crypto.createHash("sha256").update(password).digest();
  const passwordHash = Uint8Array.from(hashBuffer);

  before(async () => {
    // 에어드랍 등 계정 준비
    const airdropHiderSig = await provider.connection.requestAirdrop(hider.publicKey, 2e9);
    await provider.connection.confirmTransaction(airdropHiderSig);
    const airdropClaimerSig = await provider.connection.requestAirdrop(claimer.publicKey, 2e9);
    await provider.connection.confirmTransaction(airdropClaimerSig);

    // PDA 생성
    [vaultPda, vaultBump] = await PublicKey.findProgramAddress(
      [Buffer.from("vault"), Buffer.from(passwordHash)],
      program.programId
    );
    [feeAccountPda, feeBump] = await PublicKey.findProgramAddress(
      [Buffer.from("fees")],
      program.programId
    );

    // 토큰 민트 및 계좌 생성 (hider 사용)
    mint = await splToken.Token.createMint(
      provider.connection,
      hider, 
      hider.publicKey, 
      null,
      0, 
      splToken.TOKEN_PROGRAM_ID
    );
    assetAccount = await mint.createAccount(hider.publicKey);
    await mint.mintTo(assetAccount, hider.publicKey, [hider], 100);
  });

  it("hides vault", async () => {
    await program.methods.hideVault(
      Array.from(passwordHash),
      mint.publicKey,
      1,
      new BN(50)
    )
      .accounts({
        vaultPda: vaultPda,
        feeAccount: feeAccountPda,
        owner: hider.publicKey,
        assetAccount: assetAccount,
        mint: mint.publicKey,
        tokenProgram: splToken.TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([hider])
      .rpc();

    const vaultAccount = await program.account.vaultPda.fetch(vaultPda);
    assert.ok(vaultAccount.owner.equals(hider.publicKey));
    assert.strictEqual(
      Buffer.from(vaultAccount.passwordHash).toString("hex"),
      Buffer.from(passwordHash).toString("hex")
    );
    assert.ok(vaultAccount.isClaimed === false);
  });

  it("fails to unlock vault with wrong password", async () => {
    try {
      await program.methods.unlockVault(wrongPassword)
        .accounts({
          vaultPda: vaultPda,
          feeAccount: feeAccountPda,
          claimer: claimer.publicKey,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([claimer])
        .rpc();
      assert.fail("Unlocking with wrong password should have failed");
    } catch (err) {
      const errMsg = err.toString();
      assert.ok(errMsg.includes("Invalid password") || errMsg.includes("InvalidPassword"));
    }
  });

  it("unlocks vault with correct password", async () => {
    await program.methods.unlockVault(password)
      .accounts({
        vaultPda: vaultPda,
        feeAccount: feeAccountPda,
        claimer: claimer.publicKey,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([claimer])
      .rpc();

    const vaultAccount = await program.account.vaultPda.fetch(vaultPda);
    assert.ok(vaultAccount.claimer.equals(claimer.publicKey));
  });

  it("claims treasure", async () => {
    await program.methods.claimTreasure(vaultBump)
      .accounts({
        vaultPda: vaultPda,
        claimer: claimer.publicKey,
        tokenProgram: splToken.TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: assetAccount, isSigner: false, isWritable: true },
      ])
      .signers([claimer])
      .rpc();

    const vaultAccount = await program.account.vaultPda.fetch(vaultPda);
    assert.ok(vaultAccount.isClaimed === true);
    assert.strictEqual(vaultAccount.assets.length, 0);
  });
});

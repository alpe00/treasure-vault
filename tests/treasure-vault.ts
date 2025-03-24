import * as fs from "fs";
import anchor from "@coral-xyz/anchor";
const { Program, Provider, web3, BN } = anchor;
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import * as splToken from "@solana/spl-token";
import * as crypto from "crypto";

// 추가: 새로운 함수들을 별도로 임포트
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";

// IDL 파일 경로 (프로젝트에 맞게 조정)
const idlPath = `${process.cwd()}/target/idl/treasure_vault.json`;
const idlRaw = fs.readFileSync(idlPath, "utf8");
let idlFixed = JSON.parse(idlRaw);

// Program ID는 실제 배포된 프로그램의 ID로 설정
const programId = new PublicKey("G8RBzoNGqmAWvhLUTpJyVhzMWCtAXk3nrBoC7Q2MEeit");

describe("treasure_vault", () => {
  const provider: Provider = anchor.AnchorProvider.env();

  // 간단한 sendAndConfirm 구현을 추가 (실제 사용 환경에 따라 옵션 등을 조정할 수 있음)
  if (!provider.sendAndConfirm) {
    provider.sendAndConfirm = async (tx, signers, options?) => {
      // tx를 보내고 서명을 기다림
      const signature = await provider.send(tx, signers, options);
      // 트랜잭션 확인 (commitment 등 옵션을 활용할 수 있음)
      await provider.connection.confirmTransaction(signature, options?.commitment || "finalized");
      return signature;
    };
  }

  anchor.setProvider(provider);
  
  const program = new Program(idlFixed, programId);

  // 테스트에서 사용할 계정 및 변수 설정
  const hider = web3.Keypair.generate();
  const claimer = web3.Keypair.generate();

  let vaultPda: PublicKey, vaultBump: number;
  let feeAccountPda: PublicKey, feeBump: number;
  let mint: PublicKey; // 이제 mint는 PublicKey 타입
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

    // **새로운 API로 토큰 민트 및 계좌 생성 (hider 사용)**
    mint = await createMint(
      provider.connection,
      hider,                // payer
      hider.publicKey,      // mint authority
      null,                 // freeze authority (없으면 null)
      0                     // decimals
    );

    // hider의 Associated Token Account 생성
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      hider,                // payer
      mint,                 // mint
      hider.publicKey       // owner
    );
    assetAccount = ata.address;

    // 토큰 발행 (예: 100개)
    await mintTo(
      provider.connection,
      hider,                // payer
      mint,                 // mint
      assetAccount,         // destination account
      hider,                // authority
      100
    );
  });

  it("hides vault", async () => {
    await program.methods.hideVault(
      Array.from(passwordHash),
      mint,
      1,
      new BN(50)
    )
      .accounts({
        vaultPda: vaultPda,
        feeAccount: feeAccountPda,
        owner: hider.publicKey,
        assetAccount: assetAccount,
        mint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
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
        tokenProgram: TOKEN_PROGRAM_ID,
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

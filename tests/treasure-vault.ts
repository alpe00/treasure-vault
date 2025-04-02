import * as fs from "fs";
import anchor from "@coral-xyz/anchor";
const { Program, Provider, BN, web3 } = anchor;
// default import 방식으로 @solana/web3.js를 가져옵니다.
import web3pkg from "@solana/web3.js";
const { PublicKey, Transaction } = web3pkg;
import { assert } from "chai";
import * as splToken from "@solana/spl-token";
import * as crypto from "crypto";

// 만약 Provider.sendAndConfirm이 없을 경우를 대비하여 프로토타입 패치 (반드시 Provider 생성 이전에)
import { AnchorProvider } from "@coral-xyz/anchor";
if (!AnchorProvider.prototype.sendAndConfirm) {
  AnchorProvider.prototype.sendAndConfirm = async function (
    tx: Transaction,
    signers: web3.Signer[],
    options?: anchor.web3.ConfirmOptions
  ): Promise<string> {
    const signature = await this.send(tx, signers, options);
    await this.connection.confirmTransaction(signature, options?.commitment || "finalized");
    return signature;
  };
}

// Provider 설정
const provider: Provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

/*
// IDL 파일 경로 (프로젝트에 맞게 조정)
const idlPath = `${process.cwd()}/target/idl/treasure_vault.json`;
const idlRaw = fs.readFileSync(idlPath, "utf8");
let idlFixed = JSON.parse(idlRaw);

// Program ID는 실제 배포된 프로그램의 ID로 설정
const programId = new PublicKey("2j3v3oGQdpwqkm5hAFABxo3dWos8XVoJUGhx2XA2Hf11");

const program = new Program(idlFixed, programId);
*/

// 프로그램은 workspace에서 가져오거나, 직접 Program 객체를 생성할 수 있습니다.
// 여기서는 workspace를 사용한다고 가정합니다.
const program = anchor.workspace.TreasureVault as Program; // 타입이 자동 생성된 경우 사용

// 테스트에 사용할 계정 및 변수 설정
const hider = web3.Keypair.generate();
const claimer = web3.Keypair.generate();

let vaultPda: PublicKey, vaultBump: number;
let feeAccountPda: PublicKey, feeBump: number;
let mint: PublicKey;
let assetAccount: PublicKey;

// 테스트에서 사용할 비밀번호와 해시값
const password = "secret_password_3";
const wrongPassword = "wrong_password";
const hashBuffer = crypto.createHash("sha256").update(password).digest();
const passwordHash = Uint8Array.from(hashBuffer);

describe("treasure_vault", () => {
  before(async () => {
    // hider와 claimer에게 에어드랍하여 충분한 SOL 확보
    const airdropHiderSig = await provider.connection.requestAirdrop(hider.publicKey, 2e9);
    await provider.connection.confirmTransaction(airdropHiderSig);
    const airdropClaimerSig = await provider.connection.requestAirdrop(claimer.publicKey, 2e9);
    await provider.connection.confirmTransaction(airdropClaimerSig);

    // vault PDA 생성 (seeds: ["vault", passwordHash])
    [vaultPda, vaultBump] = await PublicKey.findProgramAddress(
      [Buffer.from("vault"), Buffer.from(passwordHash)],
      program.programId
    );
    // fee_account PDA 생성 (seeds: ["fees"])
    [feeAccountPda, feeBump] = await PublicKey.findProgramAddress(
      [Buffer.from("fees")],
      program.programId
    );

    // 토큰 민트 생성 (hider가 payer 및 mint authority)
    mint = await splToken.createMint(
      provider.connection,
      hider,                // payer
      hider.publicKey,      // mint authority
      null,                 // freeze authority 없음
      0                     // decimals
    );

    // hider의 Associated Token Account 생성
    const ata = await splToken.getOrCreateAssociatedTokenAccount(
      provider.connection,
      hider,                // payer
      mint,                 // mint
      hider.publicKey       // owner
    );
    assetAccount = ata.address;

    // hider에게 토큰 발행 (예: 100개)
    await splToken.mintTo(
      provider.connection,
      hider,                // payer
      mint,                 // mint
      assetAccount,         // destination ATA
      hider,                // mint authority
      100
    );
  });

  it("hides vault", async () => {
    // hide_vault 호출
    await program.methods.hideVault(
      Array.from(passwordHash), // [u8;32] 배열
      mint,                     // 토큰 민트
      1,                        // asset_type (예시)
      new BN(50)                // amount (예시)
    )
      .accounts({
        vaultPda: vaultPda,
        feeAccount: feeAccountPda,
        owner: hider.publicKey,
        assetAccount: assetAccount,
        mint: mint,
        tokenProgram: splToken.TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([hider])
      .rpc();

    // vault 계정 데이터를 가져와 검증
    const vaultAccount = await program.account.vaultPda.fetch(vaultPda);
    assert.ok(vaultAccount.owner.equals(hider.publicKey));
    assert.strictEqual(
      Buffer.from(vaultAccount.passwordHash).toString("hex"),
      Buffer.from(passwordHash).toString("hex")
    );
    assert.ok(vaultAccount.isClaimed === false);
    // assets 배열에 자산 정보가 추가되었는지 확인 (적어도 하나 이상)
    assert.ok(vaultAccount.assets.length > 0);
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
      // 에러 메시지에 "Invalid password" 또는 "InvalidPassword"가 포함되어야 합니다.
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
    // unlock 후, vault 계정의 claimer 필드가 claimer의 publicKey로 설정되어야 합니다.
    assert.ok(vaultAccount.claimer.equals(claimer.publicKey));
  });

  it("claims treasure", async () => {
    // claim_treasure 호출; remaining_accounts에 숨겨진 자산 계좌(assetAccount) 전달
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
    // claim 후, vault가 클레임되었고, 자산 목록이 비워져야 합니다.
    assert.ok(vaultAccount.isClaimed === true);
    assert.strictEqual(vaultAccount.assets.length, 0);
  });
});

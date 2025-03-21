use anchor_lang::prelude::*;

declare_id!("2j3v3oGQdpwqkm5hAFABxo3dWos8XVoJUGhx2XA2Hf11");

#[program]
pub mod treasure_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}

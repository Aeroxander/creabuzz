//! ZeroDev config for SIWE smart accounts (creabuzz).
//!
//! Reads the same env vars the relay honors, with desktop-specific defaults
//! that point at the creabuzz ZeroDev project on Sepolia. All values are
//! compile/env-overridable so a production deploy can target any chain.

/// ZeroDev configuration for the desktop SIWE flow.
#[derive(Debug, Clone)]
pub struct SiweConfig {
    /// ZeroDev project id used to derive bundler/paymaster URLs.
    pub project_id: String,
    /// Explicit JSON-RPC URL (empty → ZeroDev derives one from the project).
    pub rpc_url: String,
    /// EIP-155 chain id for SIWE messages and the Kernel account.
    pub chain_id: u64,
}

impl SiweConfig {
    /// Build config from `BUZZ_ZERODEV_PROJECT_ID` / `BUZZ_ZERODEV_RPC_URL` /
    /// `BUZZ_EVM_CHAIN_ID` (same names as the relay), falling back to the
    /// creabuzz Sepolia defaults.
    pub fn from_env() -> Self {
        let project_id = std::env::var("BUZZ_ZERODEV_PROJECT_ID")
            .unwrap_or_else(|_| "42181dd8-1500-4295-ad14-b41ff6acbf0b".to_string());
        let rpc_url = std::env::var("BUZZ_ZERODEV_RPC_URL").unwrap_or_else(|_| {
            format!("https://rpc.zerodev.app/api/v3/{project_id}/chain/11155111")
        });
        let chain_id = std::env::var("BUZZ_EVM_CHAIN_ID")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(11155111);
        SiweConfig {
            project_id,
            rpc_url,
            chain_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_target_sepolia() {
        // Env absent in test → fall back to creabuzz defaults.
        let config = SiweConfig::from_env();
        assert_eq!(config.chain_id, 11155111);
        assert!(!config.project_id.is_empty());
        assert!(config.rpc_url.contains("/chain/11155111"));
    }
}

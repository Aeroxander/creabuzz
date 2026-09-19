use std::time::Duration;

use crate::managed_agents::paperclip_env::local_health_url;

pub(crate) async fn paperclip_health(
    client: &reqwest::Client,
    host: &str,
    port: u16,
) -> Result<(), String> {
    let url = local_health_url(host, port)
        .ok_or_else(|| "Paperclip reported a non-loopback address".to_string())?;
    let response = tokio::time::timeout(Duration::from_secs(2), client.get(url).send())
        .await
        .map_err(|_| "Paperclip health check timed out".to_string())?
        .map_err(|error| format!("Paperclip health check failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Paperclip health check failed with status {}",
            response.status()
        ));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("Paperclip health response was not JSON: {error}"))?;
    if body.get("status").and_then(serde_json::Value::as_str) == Some("ok") {
        Ok(())
    } else {
        Err("Paperclip health check did not report ok".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_rejects_non_loopback_hosts() {
        let client = reqwest::Client::new();
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime builds")
            .block_on(paperclip_health(&client, "example.com", 3100));
        assert_eq!(
            result,
            Err("Paperclip reported a non-loopback address".to_string())
        );
    }
}

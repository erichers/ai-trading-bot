//! LLM clients: Moonshot Kimi (OpenAI-compatible) + local Ollama (Gemma).

use crate::config::Settings;
use reqwest::Client;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone)]
pub struct Llm {
    pub settings: Arc<Settings>,
    pub http: Client,
}

impl Llm {
    pub fn new(settings: Arc<Settings>) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(220))
            .build()
            .expect("llm http client");
        Llm { settings, http }
    }

    pub async fn ollama_connected(&self) -> bool {
        let url = format!("{}/api/tags", self.settings.ollama_base_url);
        match self
            .http
            .get(&url)
            .timeout(Duration::from_secs(3))
            .send()
            .await
        {
            Ok(r) => r.status().is_success(),
            Err(_) => false,
        }
    }

    /// Kimi chat completion. Returns assistant content. kimi-k2.5 needs temperature=1.
    pub async fn kimi_chat(
        &self,
        system: &str,
        user: &str,
        json_format: bool,
        max_tokens: u32,
    ) -> anyhow::Result<String> {
        if !self.settings.kimi_configured() {
            anyhow::bail!("Kimi API key not configured");
        }
        let effective_max = max_tokens.max(4000);
        let mut body = json!({
            "model": self.settings.kimi_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 1,
            "max_tokens": effective_max,
        });
        if json_format {
            body["response_format"] = json!({"type": "json_object"});
        }
        let url = format!(
            "{}/chat/completions",
            self.settings.kimi_base_url.trim_end_matches('/')
        );
        let resp = self
            .http
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.settings.kimi_api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            anyhow::bail!("Kimi {} : {}", status, text);
        }
        let data: Value = serde_json::from_str(&text)?;
        let msg = &data["choices"][0]["message"];
        let content = msg["content"].as_str().unwrap_or("").trim().to_string();
        if !content.is_empty() {
            return Ok(content);
        }
        let reasoning = msg["reasoning_content"].as_str().unwrap_or("").trim().to_string();
        if !reasoning.is_empty() {
            return Ok(reasoning);
        }
        anyhow::bail!(
            "Kimi returned empty content (finish_reason={})",
            data["choices"][0]["finish_reason"]
        )
    }

    /// Ollama chat (Gemma). think:false, keep_alive, format json.
    pub async fn ollama_chat(
        &self,
        system: &str,
        user: &str,
        json_format: bool,
        num_predict: u32,
    ) -> anyhow::Result<String> {
        let mut payload = json!({
            "model": self.settings.research_model,
            "stream": false,
            "think": false,
            "keep_alive": "30m",
            "options": {"num_predict": num_predict, "temperature": 0.4},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        });
        if json_format {
            payload["format"] = json!("json");
        }
        let url = format!("{}/api/chat", self.settings.ollama_base_url);
        let resp = self
            .http
            .post(&url)
            .timeout(Duration::from_secs(120))
            .json(&payload)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            anyhow::bail!("Ollama {} : {}", status, text);
        }
        let data: Value = serde_json::from_str(&text)?;
        Ok(data["message"]["content"].as_str().unwrap_or("").to_string())
    }

    /// Local Ollama embeddings: POST /api/embeddings {model, prompt} -> Vec<f32>.
    /// Returns an error (NOT mock) so callers can fall back to keyword retrieval.
    pub async fn embed(&self, text: &str) -> anyhow::Result<Vec<f32>> {
        let payload = json!({
            "model": self.settings.embed_model,
            "prompt": text,
        });
        let url = format!("{}/api/embeddings", self.settings.ollama_base_url);
        let resp = self
            .http
            .post(&url)
            .timeout(Duration::from_secs(60))
            .json(&payload)
            .send()
            .await?;
        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            anyhow::bail!("Ollama embeddings {} : {}", status, body);
        }
        let data: Value = serde_json::from_str(&body)?;
        let arr = data["embedding"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("embeddings response missing 'embedding' array"))?;
        let v: Vec<f32> = arr.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect();
        if v.is_empty() {
            anyhow::bail!("embeddings returned an empty vector");
        }
        Ok(v)
    }
}

/// Loose JSON parse: strip ```json fences, fall back to first {...} block.
pub fn parse_json_loose(text: &str) -> anyhow::Result<Value> {
    let mut t = text.trim().to_string();
    if t.starts_with("```") {
        // strip leading fence
        if let Some(idx) = t.find('\n') {
            t = t[idx + 1..].to_string();
        }
        if let Some(idx) = t.rfind("```") {
            t = t[..idx].to_string();
        }
        t = t.trim().to_string();
    }
    if let Ok(v) = serde_json::from_str::<Value>(&t) {
        return Ok(v);
    }
    // first {...} block
    if let (Some(start), Some(end)) = (t.find('{'), t.rfind('}')) {
        if end > start {
            let block = &t[start..=end];
            return Ok(serde_json::from_str::<Value>(block)?);
        }
    }
    anyhow::bail!("could not parse JSON from LLM output")
}

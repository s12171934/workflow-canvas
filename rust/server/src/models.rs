use serde_json::{Value, json};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::{process::Command, sync::Mutex};
use workflow_core::{JsonExt, model};
pub struct Models {
    cache: Mutex<Option<(Instant, Duration, Value)>>,
}
pub fn latest(models: &Value) -> Vec<String> {
    ["opus", "sonnet", "haiku", "fable"]
        .iter()
        .filter_map(|family| {
            let prefix = format!("claude-{family}");
            models
                .list()
                .iter()
                .filter(|m| m.s("id") == prefix || m.s("id").starts_with(&format!("{prefix}-")))
                .max_by_key(|m| {
                    chrono::DateTime::parse_from_rfc3339(m.s("created_at"))
                        .map(|d| d.timestamp_millis())
                        .unwrap_or(0)
                })
                .map(|m| m.s("id").into())
        })
        .collect()
}
impl Models {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(None),
        }
    }
    pub async fn list(&self) -> Value {
        let mut cache = self.cache.lock().await;
        if let Some((at, ttl, v)) = &*cache {
            if at.elapsed() < *ttl {
                return v.clone();
            }
        }
        let result = self.fetch().await;
        let (ttl, value) = match result {
            Ok(models) => (
                Duration::from_secs(3600),
                json!({"models":models,"source":"api"}),
            ),
            Err(error) => {
                let mut fallback = cache
                    .as_ref()
                    .filter(|(_, _, v)| v.s("source") == "api")
                    .map(|(_, _, v)| v.clone())
                    .unwrap_or(json!({"models":model::MODELS,"source":"fallback"}));
                fallback["error"] = json!(error);
                (Duration::from_secs(300), fallback)
            }
        };
        *cache = Some((Instant::now(), ttl, value.clone()));
        value
    }
    async fn fetch(&self) -> std::result::Result<Vec<String>, String> {
        let mut headers = HashMap::new();
        if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
            headers.insert("x-api-key", key);
        } else {
            let oauth = |bytes: &[u8]| {
                serde_json::from_slice::<Value>(bytes).ok().and_then(|v| {
                    v["claudeAiOauth"]["accessToken"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                })
            };
            let mut token = None;
            if cfg!(target_os = "macos") {
                let mut command = Command::new("security");
                command
                    .args([
                        "find-generic-password",
                        "-s",
                        "Claude Code-credentials",
                        "-w",
                    ])
                    .kill_on_drop(true);
                if let Ok(Ok(out)) =
                    tokio::time::timeout(Duration::from_secs(5), command.output()).await
                {
                    if out.status.success() {
                        token = oauth(&out.stdout)
                    }
                }
            }
            if token.is_none() {
                if let Some(home) = std::env::var_os("HOME") {
                    if let Ok(raw) = tokio::fs::read(
                        std::path::PathBuf::from(home).join(".claude/.credentials.json"),
                    )
                    .await
                    {
                        token = oauth(&raw)
                    }
                }
            }
            let Some(token) = token else {
                return Err("Anthropic 자격 증명(ANTHROPIC_API_KEY 또는 Claude Code 로그인)을 찾지 못했습니다.".into());
            };
            headers.insert("authorization", format!("Bearer {token}"));
            headers.insert("anthropic-beta", "oauth-2025-04-20".into());
        }
        let client = reqwest::Client::new();
        let mut req = client
            .get("https://api.anthropic.com/v1/models?limit=1000")
            .timeout(Duration::from_secs(10))
            .header("anthropic-version", "2023-06-01");
        for (k, v) in headers {
            req = req.header(k, v)
        }
        let response = req
            .send()
            .await
            .map_err(|_| "Models API 조회에 실패했습니다.".to_owned())?;
        if !response.status().is_success() {
            return Err(format!("Models API 응답 {}", response.status().as_u16()));
        }
        let data: Value = response
            .json()
            .await
            .map_err(|_| "Models API 응답 형식 오류".to_owned())?;
        let models = latest(&data["data"]);
        if models.is_empty() {
            return Err("Models API 가 쓸 수 있는 모델을 돌려주지 않았습니다.".into());
        }
        Ok(models)
    }
}

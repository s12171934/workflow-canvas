mod app;
mod bridge;
mod error;
mod execute;
mod models;
mod prompts;
mod runlog;
mod store;
use axum::{Router, routing::any};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, Write},
    path::PathBuf,
    sync::Arc,
};
use workflow_core::{JsonExt, strings};
fn compute(op: &str, a: &Value) -> error::Result<Value> {
    Ok(match op {
        "preflight" => execute::preflight_with(
            &a[0],
            if a[2].is_string() {
                Err(error::Error::new(400, a[2].text()))
            } else {
                Ok(a[1].clone())
            },
        ),
        "composeBrief" => prompts::compose(&a[0])?,
        "buildBrief" => prompts::compose(&a[0])?["brief"].clone(),
        "workflowPrompt" => json!(prompts::workflow_prompt(&a[0])),
        "briefPrompt" => json!(prompts::brief_prompt(&a[0])),
        "generatedWorkflow" => prompts::generated(&a[0], a[1].text())?,
        "latestPerFamily" => json!(models::latest(&a[0])),
        "outcomeOf" => json!(runlog::outcome(&a[0], a[1].list())),
        "ended" => json!(runlog::ended(a[0].list())),
        "allowedHost" => json!(app::allowed_host(a[0].text())),
        "documentVersion" => json!(app::version(&a[0])),
        _ => workflow_core::dispatch(op, a)?,
    })
}
fn rpc() -> error::Result<()> {
    let mut logs: HashMap<String, runlog::RunLog> = HashMap::new();
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let op = request.s("op");
        let a = &request["args"];
        let value = if let Some(method) = op.strip_prefix("log.") {
            let root = a[0].text().to_owned();
            let log = logs
                .entry(root.clone())
                .or_insert_with(|| runlog::RunLog::new(root.into()));
            (move || -> error::Result<Value> {
                Ok(match method {
                    "start" => {
                        log.start(a[1].text(), &a[2])?;
                        Value::Null
                    }
                    "append" => {
                        log.append(a[1].text(), &a[2])?;
                        Value::Null
                    }
                    "appendRun" => {
                        log.append_run(a[1].text(), &a[2])?;
                        Value::Null
                    }
                    "register" => log.register(a[1].text(), a[2].text(), &a[3], a[4].text())?,
                    "adopt" => {
                        log.adopt(a[1].text(), a[2].text(), a[3].text(), &a[4])?;
                        Value::Null
                    }
                    "observe" => {
                        log.observe(&a[1])?;
                        Value::Null
                    }
                    "meta" => log.meta(a[1].text()),
                    "patchMeta" => {
                        log.patch(a[1].text(), &a[2])?;
                        Value::Null
                    }
                    "coordinatorsToClose" => log.coordinators_close(
                        a[1].as_i64().unwrap_or(runlog::millis()),
                        a[2].as_i64().unwrap_or(600000),
                    ),
                    "coordinatorsToWatch" => {
                        log.coordinators_watch(a[1].as_i64().unwrap_or(runlog::millis()))
                    }
                    "markLost" => json!(log.mark_lost(a[1].text(), a[2].text())?),
                    "liveByWorkflow" => log.live(),
                    "overview" => log.overview(&strings(&a[1])),
                    "metaOfRun" => log
                        .owner(a[1].text())
                        .map(|id| log.meta(&id))
                        .unwrap_or(Value::Null),
                    "runPace" => {
                        json!(log.pace(a[1].text(), a[2].as_i64().unwrap_or(runlog::millis())))
                    }
                    "launchOfRun" => json!(log.owner(a[1].text())),
                    "list" => log.list(a[1].text())?,
                    "detail" => log.detail(a[1].text(), a[2].text())?,
                    "files" => json!(log.files(a[1].text())),
                    "file" => log.file(a[1].text(), a[2].text(), a[3].text())?,
                    "watchTargets" => json!(log.watch_targets()),
                    _ => return Err(error::Error::new(400, "알 수 없는 로그 연산")),
                })
            })()
        } else if let Some(method) = op.strip_prefix("store.") {
            let store = store::Store::new(a[0].text().into());
            (move || -> error::Result<Value> {
                Ok(match method {
                    "list" => json!(store.list()?),
                    "load" => store.load(a[1].text())?,
                    "save" => store.save(&a[1])?,
                    "remove" => {
                        store.remove(a[1].text())?;
                        Value::Null
                    }
                    "seed" => json!(store.seed(std::path::Path::new(a[1].text()))?),
                    _ => return Err(error::Error::new(400, "알 수 없는 저장 연산")),
                })
            })()
        } else {
            compute(op, a)
        };
        let output = match value {
            Ok(value) => json!({"id":request["id"],"value":value}),
            Err(error) => json!({"id":request["id"],"error":error.message,"status":error.status}),
        };
        println!("{output}");
        std::io::stdout().flush()?;
    }
    Ok(())
}
#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("{}", e.message);
        std::process::exit(1)
    }
}
async fn run() -> error::Result<()> {
    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments.iter().any(|a| a == "--rpc") {
        return rpc();
    }
    if arguments.iter().any(|a| a == "--compute") {
        let mut input = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut input)?;
        let request: Value = serde_json::from_str(&input)?;
        let response = match compute(request.s("op"), &request["args"]) {
            Ok(value) => json!({"value":value}),
            Err(e) => json!({"error":e.message,"status":e.status}),
        };
        println!("{response}");
        return Ok(());
    }
    if arguments.iter().any(|a| a == "--help") {
        println!(
            "workflow-canvas [--port <port>] [--data-dir <path>]\nLocal Orca graph canvas; binds to 127.0.0.1."
        );
        return Ok(());
    }
    let arg = |name: &str| {
        arguments
            .iter()
            .position(|a| a == name)
            .and_then(|i| arguments.get(i + 1))
            .cloned()
    };
    let port = arg("--port")
        .or_else(|| std::env::var("WORKFLOW_CANVAS_PORT").ok())
        .unwrap_or("4318".into())
        .parse::<u16>()
        .map_err(|_| error::Error::new(400, "올바른 포트가 필요합니다."))?;
    let root = arg("--root")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    let directory = arg("--data-dir")
        .or_else(|| std::env::var("WORKFLOW_CANVAS_DATA_DIR").ok())
        .map(PathBuf::from)
        .unwrap_or(root.join(".local/workflows"));
    let directory = if directory.is_absolute() {
        directory
    } else {
        std::env::current_dir()?.join(directory)
    };
    let store = store::Store::new(directory);
    let testing = std::env::var("WORKFLOW_CANVAS_TESTING").as_deref() == Ok("1");
    if !testing {
        if let Err(e) = store.seed(&root.join("examples")) {
            eprintln!("예시 워크플로를 넣지 못했습니다: {}", e.message)
        }
    }
    let proxy = if testing { arg("--bridge-url") } else { None };
    if proxy
        .as_ref()
        .is_some_and(|s| !s.starts_with("http://127.0.0.1:"))
    {
        return Err(error::Error::new(
            400,
            "테스트 브리지는 루프백이어야 합니다.",
        ));
    }
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let local = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
    let base = if testing {
        arg("--callback-base").unwrap_or(local.clone())
    } else {
        local.clone()
    };
    let watch_ms = arg("--watch-ms")
        .and_then(|s| s.parse().ok())
        .unwrap_or(if testing { 0 } else { 10000 });
    let reap_ms = arg("--reap-ms")
        .and_then(|s| s.parse().ok())
        .unwrap_or(watch_ms.max(30000));
    let state = Arc::new(app::State::new(
        store,
        bridge::Bridge::new(proxy),
        base,
        watch_ms,
    ));
    if watch_ms > 0 {
        app::background(state.clone(), reap_ms)
    }
    let router = Router::new()
        .route("/api", any(app::api))
        .route("/api/{*path}", any(app::api));
    let router = if let Some(proxy) = arg("--dev-proxy") {
        router.fallback(move |request: axum::http::Request<axum::body::Body>| {
            let proxy = proxy.clone();
            async move {
                let url = format!("{proxy}{}", request.uri());
                match reqwest::get(url).await {
                    Ok(response) => {
                        let status = response.status();
                        let headers = response.headers().clone();
                        match response.bytes().await {
                            Ok(bytes) => {
                                let mut result =
                                    axum::response::Response::new(axum::body::Body::from(bytes));
                                *result.status_mut() = status;
                                for key in ["content-type", "cache-control"] {
                                    if let Some(value) = headers.get(key) {
                                        result.headers_mut().insert(
                                            axum::http::HeaderName::from_bytes(key.as_bytes())
                                                .unwrap(),
                                            value.clone(),
                                        );
                                    }
                                }
                                result
                            }
                            Err(_) => axum::response::IntoResponse::into_response(
                                axum::http::StatusCode::BAD_GATEWAY,
                            ),
                        }
                    }
                    Err(_) => axum::response::IntoResponse::into_response(
                        axum::http::StatusCode::BAD_GATEWAY,
                    ),
                }
            }
        })
    } else {
        router.fallback_service(
            tower_http::services::ServeDir::new(root.join("dist")).not_found_service(
                tower_http::services::ServeFile::new(root.join("dist/index.html")),
            ),
        )
    };
    let router = router.with_state(state);
    println!("Workflow Canvas: {local}");
    std::io::stdout().flush()?;
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            #[cfg(unix)]
            {
                let mut terminate =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .unwrap();
                tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
        })
        .await?;
    Ok(())
}

use crate::error::{Error, Result};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{Mutex, Semaphore},
    time::Instant,
};
use workflow_core::{JsonExt, model, validate};
#[derive(Clone)]
pub struct Bridge {
    pub proxy: Option<String>,
    client: reqwest::Client,
    limit: Arc<Semaphore>,
    cache: Arc<Mutex<HashMap<String, Arc<Mutex<Option<(Instant, Value)>>>>>>,
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn command() -> String {
    std::env::var("ORCA_CLI_COMMAND").unwrap_or_else(|_| {
        if std::env::var_os("ORCA_DEV_REPO_ROOT").is_some() {
            "orca-dev"
        } else if cfg!(target_os = "linux")
            && std::env::var_os("ORCA_TERMINAL_HANDLE").is_none()
            && std::env::var_os("ORCA_WORKSPACE_ID").is_none()
        {
            "orca-ide"
        } else {
            "orca"
        }
        .into()
    })
}
fn args(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).into()).collect()
}
fn absolute(v: &Value) -> bool {
    v.is_string() && v.text().starts_with('/') && !validate::control(v.text())
}
fn summary(r: &Value) -> Value {
    json!({"id":r.s("id"),"objective":r.get("objective").and_then(Value::as_str).unwrap_or("Untitled run"),"updatedAt":r.s("updated_at")})
}
fn task(r: &Value) -> Value {
    let deps = if let Some(s) = r["deps"].as_str() {
        serde_json::from_str::<Value>(s).unwrap_or(json!([]))
    } else {
        r["deps"].clone()
    };
    let title = ["display_name", "task_title", "spec", "id"]
        .iter()
        .map(|k| r.s(k))
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .chars()
        .take(160)
        .collect::<String>();
    json!({"id":r.s("id"),"title":title,"spec":r.s("spec"),"status":r.get("status").and_then(Value::as_str).unwrap_or("unknown"),"deps":deps.list().iter().filter(|v|v.is_string()).cloned().collect::<Vec<_>>()})
}

fn worker(r: &Value) -> Value {
    let p = &r["projection"];
    let mut w = json!({"dispatchId":r.s("dispatchId"),"taskId":r.s("taskId"),"provider":p["provider"].s("id"),"model":p["provider"].s("model"),"liveness":p["liveness"].get("verdict").and_then(Value::as_str).unwrap_or("unverifiable"),"stage":p["stage"].get("activity").and_then(Value::as_str).unwrap_or(p["stage"].s("worker")),"outcome":p.s("outcome")});
    if r["agentTerminalHandle"].is_string() {
        w["terminal"] = r["agentTerminalHandle"].clone()
    }
    if r["terminalState"].is_string() {
        w["terminalState"] = r["terminalState"].clone()
    }
    w
}
impl Bridge {
    pub fn new(proxy: Option<String>) -> Self {
        Self {
            proxy,
            client: reqwest::Client::new(),
            limit: Arc::new(Semaphore::new(4)),
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    pub async fn remote(&self, method: &str, arguments: Value) -> Result<Option<Value>> {
        let Some(url) = &self.proxy else {
            return Ok(None);
        };
        let response = self
            .client
            .post(url)
            .json(&json!({"method":method,"args":arguments}))
            .send()
            .await
            .map_err(|_| Error::new(503, "테스트 브리지에 연결하지 못했습니다."))?;
        let data: Value = response
            .json()
            .await
            .map_err(|_| Error::new(503, "테스트 브리지 응답 오류"))?;
        if !data["error"].is_null() {
            return Err(Error::new(503, data.s("error")));
        }
        Ok(Some(data.get("value").cloned().unwrap_or(Value::Null)))
    }
    pub async fn exec(&self, arguments: Vec<String>, timeout_ms: u64) -> Result<Value> {
        let _permit = if timeout_ms <= 12000 {
            Some(self.limit.acquire().await.unwrap())
        } else {
            None
        };
        let mut cmd = Command::new(command());
        cmd.args(&arguments)
            .arg("--json")
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| {
            Error::new(
                503,
                if e.kind() == std::io::ErrorKind::NotFound {
                    "Orca CLI를 찾지 못했습니다. ORCA_CLI_COMMAND를 실행 파일 경로로 설정하세요."
                } else {
                    "Orca CLI 조회에 실패했습니다. Orca 앱 실행 상태와 CLI 버전을 확인하세요."
                },
            )
        })?;
        let collect = async {
            async fn bounded(reader: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>> {
                let mut bytes = Vec::new();
                reader
                    .take(8 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .await?;
                if bytes.len() > 8 * 1024 * 1024 {
                    return Err(Error::new(503, "Orca CLI 응답이 너무 큽니다."));
                }
                Ok(bytes)
            }
            let (stdout, _stderr) = tokio::try_join!(
                bounded(child.stdout.take().unwrap()),
                bounded(child.stderr.take().unwrap())
            )?;
            let status = child.wait().await?;
            Ok::<_, Error>((status, stdout))
        };
        let(status,stdout)=tokio::time::timeout(Duration::from_millis(timeout_ms),collect).await
            .map_err(|_|Error::new(503,format!("Orca CLI가 {}초 안에 응답하지 않았습니다. 시스템 부하나 동시에 돌고 있는 에이전트 수를 확인하세요.",timeout_ms/1000)))??;
        let data: Value = serde_json::from_slice(&stdout).map_err(|_| {
            Error::new(
                503,
                "Orca CLI 조회에 실패했습니다. Orca 앱 실행 상태와 CLI 버전을 확인하세요.",
            )
        })?;
        if !status.success() || !data.b("ok") || data["result"].is_null() {
            let code = data["error"].s("code");
            if code.contains("stale") || code.contains("not_found") {
                return Err(Error::new(404, "Orca 터미널이 없습니다."));
            }
            return Err(Error::new(
                503,
                if data["error"].s("message").is_empty() {
                    "Orca CLI 조회에 실패했습니다. Orca 앱 실행 상태와 CLI 버전을 확인하세요."
                } else {
                    data["error"].s("message")
                },
            ));
        }
        Ok(data["result"].clone())
    }
    pub async fn read(
        &self,
        method: &str,
        arguments: Value,
        max_age: Option<u64>,
    ) -> Result<Value> {
        if let Some(v) = self.remote(method, arguments.clone()).await? {
            return Ok(v);
        }
        let ttl = max_age.unwrap_or(0).max(match method {
            "status" => 4000,
            "locations" | "automations" => 10000,
            "runs" => 30000,
            "snapshot" => 2000,
            "run" => 600000,
            _ => 0,
        });
        let asked = Instant::now();
        let key = format!(
            "{method}:{}",
            if method == "snapshot" {
                json!([arguments[0]])
            } else {
                arguments.clone()
            }
        );
        let slot = self
            .cache
            .lock()
            .await
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone();
        let mut cached = slot.lock().await;
        if let Some((at, v)) = &*cached {
            if *at >= asked || at.elapsed().as_millis() < (ttl as u128) {
                return Ok(v.clone());
            }
        }
        let value = self.load(method, &arguments).await;
        match value {
            Ok(v) => {
                *cached = Some((Instant::now(), v.clone()));
                Ok(v)
            }
            Err(e) => {
                if method != "status" {
                    if let Some((at, v)) = &*cached {
                        if at.elapsed() < Duration::from_secs(60) {
                            return Ok(v.clone());
                        }
                    }
                }
                Err(e)
            }
        }
    }
    async fn load(&self, method: &str, a: &Value) -> Result<Value> {
        match method {
            "status" => {
                let r = self.exec(args(&["status"]), 12000).await?;
                Ok(
                    json!({"connected":r["runtime"].b("reachable")&&r["runtime"].s("state")=="ready","version":r["runtime"].s("appVersion"),"observedAt":now()}),
                )
            }
            "locations" => {
                let (repos, worktrees) = tokio::try_join!(
                    self.exec(args(&["repo", "list"]), 12000),
                    self.exec(args(&["worktree", "list", "--limit", "500"]), 12000)
                )?;
                let map = |r: &Value, worktree: bool| {
                    let mut n = json!({"id":r.s("id"),"name":if r.s("displayName").is_empty(){r.s("path").rsplit('/').next().unwrap_or("")}else{r.s("displayName")},"path":r["path"]});
                    if worktree {
                        n["repoId"] = json!(r.s("repoId"));
                        if r["branch"].is_string() {
                            n["branch"] = json!(r.s("branch").trim_start_matches("refs/heads/"))
                        }
                    }
                    n
                };
                Ok(
                    json!({"projects":repos.a("repos").iter().filter(|r|absolute(&r["path"])).map(|r|map(r,false)).collect::<Vec<_>>(),"worktrees":worktrees.a("worktrees").iter().filter(|r|absolute(&r["path"])&&!r.b("isArchived")&&!r.b("isBare")).map(|r|map(r,true)).collect::<Vec<_>>()}),
                )
            }
            "automations" => {
                let r = self.exec(args(&["automations", "list"]), 12000).await?;
                Ok(json!(r.a("automations").iter().map(|r|{let mut a=json!({"orcaId":r.s("id"),"name":r.s("name"),"enabled":r.b("enabled")});workflow_core::copy_keys(&mut a,r,&["nextRunAt","lastRunAt","rrule"]);a}).collect::<Vec<_>>()))
            }
            "runs" => {
                let mut runs = vec![];
                let mut cursor = None;
                let mut seen = HashSet::new();
                loop {
                    let mut command =
                        args(&["orchestration", "run-list", "--full", "--limit", "100"]);
                    if let Some(c) = cursor {
                        command.extend(["--cursor".into(), c]);
                    }
                    let p = self.exec(command, 12000).await?;
                    runs.extend(p.a("runs").iter().map(summary));
                    if p["nextCursor"].is_null() {
                        break;
                    }
                    let c = p["nextCursor"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| p["nextCursor"].to_string());
                    if !seen.insert(c.clone()) {
                        return Err(Error::new(503, "Orca Run 페이지 커서가 반복되었습니다."));
                    }
                    cursor = Some(c)
                }
                Ok(json!(runs))
            }
            "snapshot" => self.snapshot_uncached(a[0].text()).await,
            "run" => {
                self.exec(
                    args(&["orchestration", "run-show", "--full", "--id", a[0].text()]),
                    12000,
                )
                .await
            }
            _ => Err(Error::new(503, "알 수 없는 Orca 조회입니다.")),
        }
    }
    pub async fn snapshot_uncached(&self, id: &str) -> Result<Value> {
        if !validate::valid_id(id) {
            return Err(Error::new(400, "올바르지 않은 Run ID입니다."));
        }
        if let Some(v) = self.remote("loadSnapshot", json!([id])).await? {
            return Ok(v);
        }
        let (detail, tasks) = tokio::try_join!(
            Box::pin(self.read("run", json!([id]), None)),
            self.exec(
                args(&["orchestration", "task-list", "--full", "--run", id]),
                12000
            )
        )?;
        let mut workers = vec![];
        let mut cursor = None;
        let mut seen = HashSet::new();
        loop {
            let mut command = args(&[
                "orchestration",
                "worker-list",
                "--full",
                "--run",
                id,
                "--include-remote",
                "--limit",
                "100",
            ]);
            if let Some(c) = cursor {
                command.extend(["--cursor".into(), c]);
            }
            let p = self.exec(command, 12000).await?;
            workers.extend(p.a("workers").iter().map(worker));
            if !p["page"].b("hasMore") || p["page"]["nextCursor"].is_null() {
                break;
            }
            let c = p["page"]["nextCursor"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| p["page"]["nextCursor"].to_string());
            if !seen.insert(c.clone()) {
                return Err(Error::new(503, "Orca Worker 페이지 커서가 반복되었습니다."));
            }
            cursor = Some(c)
        }
        Ok(
            json!({"run":summary(&detail["run"]),"tasks":tasks.a("tasks").iter().map(task).collect::<Vec<_>>(),"workers":workers,"observedAt":now()}),
        )
    }
    pub async fn action(&self, method: &str, a: Value) -> Result<Value> {
        if let Some(v) = self.remote(method, a.clone()).await? {
            return Ok(v);
        }
        let result = match method {
            "launchCoordinator" | "launchGenerator" => {
                let mut command = args(&[
                    "agent",
                    "launch",
                    "--agent",
                    "claude",
                    "--model",
                    model::DEFAULT_MODEL,
                ]);
                if method == "launchCoordinator" {
                    command.extend(args(&["--surface", "terminal"]))
                }
                command.extend(args(&[
                    "--worktree",
                    &format!("path:{}", a[0].text()),
                    "--prompt",
                    a[1].text(),
                ]));
                let r = self.exec(command, 12000).await?;
                let text = r.to_string();
                let re = regex::Regex::new(r"term_[a-zA-Z0-9-]{1,128}").unwrap();
                re.find(&text)
                    .map(|m| json!({"terminal":m.as_str()}))
                    .unwrap_or(json!({}))
            }
            "renameTerminal" | "closeTerminal" | "terminalOpen" => {
                let terminal = a[0].text();
                if !validate::matches(r"^term_[a-zA-Z0-9-]{1,128}$", terminal) {
                    return Ok(if method == "terminalOpen" {
                        json!(false)
                    } else {
                        Value::Null
                    });
                }
                let mut command = args(&[
                    "terminal",
                    match method {
                        "renameTerminal" => "rename",
                        "closeTerminal" => "close",
                        _ => "show",
                    },
                    "--terminal",
                    terminal,
                ]);
                if method == "renameTerminal" {
                    command.extend(args(&[
                        "--title",
                        &a[1].text().chars().take(80).collect::<String>(),
                    ]))
                }
                let r = self.exec(command, 12000).await;
                if method == "terminalOpen" {
                    match r {
                        Ok(r) => json!(r["terminal"].s("handle") == terminal),
                        Err(e) if e.status == 404 => json!(false),
                        Err(e) => return Err(e),
                    }
                } else {
                    r?;
                    Value::Null
                }
            }
            "prepareWorktree" => {
                let input = &a[0];
                if !validate::valid_name(input.s("name")) {
                    return Err(Error::new(400, "올바르지 않은 워크트리 이름입니다."));
                }
                if !absolute(&input["repo"])
                    || (input.get("parent").is_some() && !absolute(&input["parent"]))
                {
                    return Err(Error::new(400, "워크트리 경로가 올바르지 않습니다."));
                }
                let listed = self
                    .exec(
                        args(&[
                            "worktree",
                            "list",
                            "--repo",
                            &format!("path:{}", input.s("repo")),
                            "--limit",
                            "500",
                        ]),
                        12000,
                    )
                    .await?;
                if let Some(found) = listed.a("worktrees").iter().find(|r| {
                    absolute(&r["path"])
                        && !r.b("isArchived")
                        && !r.b("isBare")
                        && (r.s("displayName") == input.s("name")
                            || r.s("branch").trim_start_matches("refs/heads/") == input.s("name"))
                }) {
                    return Ok(json!({"path":found["path"],"created":false}));
                }
                let mut command = args(&[
                    "worktree",
                    "create",
                    "--repo",
                    &format!("path:{}", input.s("repo")),
                    "--name",
                    input.s("name"),
                ]);
                if !input.s("baseBranch").is_empty() {
                    command.extend(args(&["--base-branch", input.s("baseBranch")]))
                }
                if !input.s("parent").is_empty() {
                    command.extend(args(&[
                        "--parent-worktree",
                        &format!("path:{}", input.s("parent")),
                    ]))
                } else {
                    command.push("--no-parent".into())
                }
                command.extend(args(&["--setup", "inherit"]));
                let r = self.exec(command, 600000).await?;
                let path = r["worktree"].get("path").unwrap_or(&r["path"]);
                if !absolute(path) {
                    return Err(Error::new(
                        503,
                        "Orca가 만든 워크트리의 경로를 확인할 수 없습니다.",
                    ));
                }
                json!({"path":path,"created":true})
            }
            "openTask" => {
                let snapshot = self.snapshot_uncached(a[0].text()).await?;
                let Some(w) = snapshot
                    .a("workers")
                    .iter()
                    .find(|w| w.s("taskId") == a[1].text())
                else {
                    return Ok(
                        json!({"opened":false,"reason":"이 Task에는 아직 워커가 없습니다."}),
                    );
                };
                if !validate::matches(r"^term_[a-zA-Z0-9-]{1,128}$", w.s("terminal")) {
                    return Ok(
                        json!({"opened":false,"reason":"워커 터미널을 확인할 수 없습니다."}),
                    );
                }
                if w.s("terminalState") == "released" {
                    return Ok(json!({"opened":false,"reason":"이미 정리된 워커입니다."}));
                }
                self.exec(
                    args(&["terminal", "switch", "--terminal", w.s("terminal")]),
                    12000,
                )
                .await?;
                json!({"opened":true})
            }
            "createAutomation" => {
                let i = &a[0];
                let mut command = args(&[
                    "automations",
                    "create",
                    "--name",
                    i.s("name"),
                    "--trigger",
                    i.s("trigger"),
                ]);
                if !i.s("time").is_empty() {
                    command.extend(args(&["--time", i.s("time")]))
                }
                if let Some(day) = i.get("day") {
                    command.extend(args(&["--day", &day.to_string()]))
                }
                command.extend(args(&[
                    "--prompt",
                    i.s("prompt"),
                    "--provider",
                    "claude",
                    "--workspace",
                    &format!("path:{}", i.s("project")),
                    "--workspace-mode",
                    "existing",
                    "--fresh-session",
                    "--enabled",
                ]));
                let r = self.exec(command, 12000).await?;
                let id = r["automation"].get("id").unwrap_or(&r["id"]);
                if !validate::matches(r"^[a-zA-Z0-9-]{1,128}$", id.text()) {
                    return Err(Error::new(
                        503,
                        "Orca가 만든 자동화의 ID를 확인할 수 없습니다.",
                    ));
                }
                id.clone()
            }
            "runAutomation" | "removeAutomation" => {
                if !validate::matches(r"^[a-zA-Z0-9-]{1,128}$", a[0].text()) {
                    return Err(Error::new(400, "올바르지 않은 자동화 ID입니다."));
                }
                self.exec(
                    args(&[
                        "automations",
                        if method == "runAutomation" {
                            "run"
                        } else {
                            "remove"
                        },
                        a[0].text(),
                    ]),
                    12000,
                )
                .await?;
                Value::Null
            }
            _ => return Err(Error::new(503, "알 수 없는 Orca 명령입니다.")),
        };
        if method.contains("Automation") {
            self.cache
                .lock()
                .await
                .retain(|k, _| !k.starts_with("automations:"));
        }
        Ok(result)
    }
}

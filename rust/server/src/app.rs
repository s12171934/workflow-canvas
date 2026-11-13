use crate::{
    bridge::Bridge,
    error::{Error, Result},
    execute,
    models::Models,
    prompts,
    runlog::{self, RunLog},
    store::Store,
};
use axum::{
    Json,
    body::{Body, to_bytes},
    extract::State as AxumState,
    http::{Request, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex, Weak},
};
use tokio::sync::Mutex;
use workflow_core::{
    JsonExt, copy_keys, drop_keys, entries, model, object, strings, validate, workflow,
};
pub struct State {
    pub store: Store,
    pub log: RunLog,
    pub bridge: Bridge,
    pub models: Models,
    pub base: String,
    pub launches: Mutex<HashMap<String, i64>>,
    pub generations: Mutex<HashMap<String, Value>>,
    locks: StdMutex<HashMap<String, Weak<Mutex<()>>>>,
    decisions: Mutex<Option<(std::time::Instant, Value)>>,
    settled: Mutex<HashMap<String, (i64, String, Value)>>,
    pub watch_ms: u64,
}
impl State {
    pub fn new(store: Store, bridge: Bridge, base: String, watch_ms: u64) -> Self {
        let log = RunLog::new(store.root.join(".executions"));
        Self {
            store,
            log,
            bridge,
            models: Models::new(),
            base,
            launches: Mutex::new(HashMap::new()),
            generations: Mutex::new(HashMap::new()),
            locks: StdMutex::new(HashMap::new()),
            decisions: Mutex::new(None),
            settled: Mutex::new(HashMap::new()),
            watch_ms,
        }
    }
    pub fn lock(&self, key: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().unwrap();
        locks.retain(|_, v| v.strong_count() > 0);
        if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(key.into(), Arc::downgrade(&lock));
        lock
    }
    pub async fn model_list(&self) -> Result<Value> {
        if let Some(v) = self.bridge.remote("models", json!([])).await? {
            return Ok(v);
        }
        Ok(self.models.list().await)
    }
}
pub fn allowed_host(host: &str) -> bool {
    validate::matches(r"^(127\.0\.0\.1|localhost)(:\d+)?$", host)
        || validate::matches(r"(?i)^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(:\d+)?$", host)
}
pub fn version(g: &Value) -> String {
    let mut doc = g.clone();
    drop_keys(&mut doc, &["runId", "executions", "automations"]);
    format!(
        "\"{}\"",
        format!("{:x}", Sha256::digest(doc.to_string().as_bytes()))[..24].to_owned()
    )
}
fn valid_match(header: &str, g: Option<&Value>) -> bool {
    g.is_some_and(|g| {
        header.split(',').any(|s| {
            let tag = s.trim().trim_start_matches("W/");
            tag == "*" || tag == version(g)
        })
    })
}
type Reply = (u16, Value, Option<String>);
fn ok(v: Value) -> Result<Reply> {
    Ok((200, v, None))
}
fn need_id(id: &str) -> Result<()> {
    if validate::valid_id(id) {
        Ok(())
    } else {
        Err(Error::new(400, "올바르지 않은 워크플로 ID입니다."))
    }
}
fn view_generation(v: &Value) -> Value {
    if v.s("status") == "pending" && runlog::millis() - v.n("createdAt") as i64 > 30 * 60 * 1000 {
        let mut next = v.clone();
        next["status"] = json!("failed");
        next["error"] = json!("생성 에이전트가 시간 안에 결과를 보내지 않았습니다.");
        next
    } else {
        v.clone()
    }
}
fn register_log(state: &State, g: &Value, run: &str, launch: &str) {
    let executions = g
        .a("executions")
        .iter()
        .filter(|e| model::execution_run(g, e) == run)
        .cloned()
        .collect::<Vec<_>>();
    let _ = state
        .log
        .register(g.s("id"), run, &model::logged(&executions), launch);
}
fn adopt(state: &State, id: &str) {
    if let Ok(g) = state.store.load(id) {
        if !g.s("runId").is_empty() && !g.a("executions").is_empty() {
            let _ = state.log.adopt(
                id,
                g.s("name"),
                g.s("runId"),
                &model::logged(g.a("executions")),
            );
        }
    }
}
pub async fn api(AxumState(state): AxumState<Arc<State>>, request: Request<Body>) -> Response {
    let headers = request.headers();
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let origin = headers.get(header::ORIGIN).and_then(|h| h.to_str().ok());
    let cross = headers.get("sec-fetch-site").and_then(|h| h.to_str().ok()) == Some("cross-site");
    let result = if !allowed_host(host) {
        Err(Error::new(403, "로컬 요청만 허용합니다."))
    } else if cross
        || origin.is_some_and(|o| o != format!("http://{host}") && o != format!("https://{host}"))
    {
        Err(Error::new(403, "같은 출처의 요청만 허용합니다."))
    } else {
        let method = request.method().as_str().to_owned();
        let path = request
            .uri()
            .path()
            .trim_end_matches('/')
            .trim_start_matches("/api")
            .trim_start_matches('/')
            .to_owned();
        let query = request.uri().query().unwrap_or("").to_owned();
        let if_match = headers
            .get(header::IF_MATCH)
            .and_then(|h| h.to_str().ok())
            .map(str::to_owned);
        match to_bytes(request.into_body(), 2 * 1024 * 1024).await {
            Err(_) => Err(Error::new(413, "요청 본문이 너무 큽니다.")),
            Ok(bytes) => {
                let body = if bytes.is_empty() {
                    Ok(object())
                } else {
                    serde_json::from_slice::<Value>(&bytes)
                        .map_err(|_| Error::new(400, "JSON 형식이 올바르지 않습니다."))
                };
                match body {
                    Ok(body) => {
                        route(state, &method, &path, &query, if_match.as_deref(), body).await
                    }
                    Err(e) => Err(e),
                }
            }
        }
    };
    let mut response = match result {
        Ok((status, value, etag)) => {
            let mut res = (StatusCode::from_u16(status).unwrap(), Json(value)).into_response();
            if let Some(tag) = etag {
                res.headers_mut().insert(header::ETAG, tag.parse().unwrap());
            }
            res
        }
        Err(e) => e.into_response(),
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
async fn route(
    state: Arc<State>,
    method: &str,
    path: &str,
    query: &str,
    if_match: Option<&str>,
    mut body: Value,
) -> Result<Reply> {
    let p = path.split('/').collect::<Vec<_>>();
    let id = p.get(1).copied().unwrap_or("");
    match (method, p.as_slice()) {
        ("GET", ["status"]) => ok(state.bridge.read("status", json!([]), None).await?),
        ("GET", ["models"]) => ok(state.model_list().await?),
        ("GET", ["runs"]) => ok(state.bridge.read("runs", json!([]), None).await?),
        ("GET", ["locations"]) => ok(state.bridge.read("locations", json!([]), None).await?),
        ("GET", ["runs", run]) => {
            if !validate::valid_id(run) {
                return Err(Error::new(400, "올바르지 않은 Run ID입니다."));
            }
            let snapshot = state.bridge.read("snapshot", json!([run]), None).await?;
            let _ = state.log.observe(&snapshot);
            ok(snapshot)
        }
        ("POST", ["runs", run, "tasks", task, "open"]) => {
            if !validate::valid_id(run) || !validate::valid_id(task) {
                return Err(Error::new(400, "올바르지 않은 Run 또는 Task ID입니다."));
            }
            let r = state.bridge.action("openTask", json!([run, task])).await?;
            if r.b("opened") {
                ok(r)
            } else {
                Err(Error::new(409, r.s("reason")))
            }
        }
        ("GET", ["workflows"]) => {
            let live = state.log.live();
            ok(json!(
                state
                    .store
                    .list()?
                    .into_iter()
                    .map(|mut g| {
                        if !live[g.s("id")].is_null() {
                            g["live"] = live[g.s("id")].clone()
                        }
                        g
                    })
                    .collect::<Vec<_>>()
            ))
        }
        ("POST", ["validate"]) => ok(validate::validate(&body)?),
        ("GET", ["executions", "overview"]) => {
            let graphs = state
                .store
                .list()?
                .iter()
                .filter_map(|g| state.store.load(g.s("id")).ok())
                .collect::<Vec<_>>();
            let runs = graphs
                .iter()
                .flat_map(|g| {
                    workflow::overview_executions(g)
                        .iter()
                        .map(|e| model::execution_run(g, e).to_owned())
                        .filter(|r| !r.is_empty())
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            let mut data = state.log.overview(&runs);
            data["graphs"] = json!(graphs);
            ok(data)
        }
        ("GET", ["decisions"]) => {
            let asked = std::time::Instant::now();
            let mut collecting = state.decisions.lock().await;
            if let Some((finished, value)) = &*collecting {
                if *finished >= asked {
                    return ok(value.clone());
                }
            }
            let live = state.log.live();
            let mut decisions = vec![];
            for (id, _) in entries(&live) {
                let Ok(g) = state.store.load(&id) else {
                    continue;
                };
                if g.a("executions").is_empty() {
                    continue;
                }
                let Ok(linked) = state.store.linked(&g) else {
                    continue;
                };
                let Ok(flow) = workflow::flow(&g, &linked) else {
                    continue;
                };
                let mut snapshots = object();
                let mut read = vec![];
                let runs = model::unique(
                    g.a("executions")
                        .iter()
                        .map(|e| model::execution_run(&g, e).to_owned())
                        .filter(|r| !r.is_empty()),
                );
                for run in &runs {
                    let executions = g
                        .a("executions")
                        .iter()
                        .filter(|e| model::execution_run(&g, e) == run)
                        .map(|e| e.s("id"))
                        .collect::<Vec<_>>()
                        .join(",");
                    let key = format!("{id}:{run}");
                    let cached = state.settled.lock().await.get(&key).cloned();
                    if let Some((at, ids, snapshot)) = cached {
                        if ids == executions && runlog::millis() - at < runlog::SETTLED_EVERY {
                            snapshots[run] = snapshot;
                            continue;
                        }
                    }
                    let age = if state.log.pace(run, runlog::millis()) == "moving" {
                        state.watch_ms
                    } else {
                        runlog::QUIET_EVERY as u64
                    };
                    if let Ok(snapshot) = state
                        .bridge
                        .read("snapshot", json!([run, age]), Some(age))
                        .await
                    {
                        snapshots[run] = snapshot;
                        read.push((run.clone(), executions));
                    }
                }
                let mut open = vec![];
                for e in g.a("executions") {
                    let run = model::execution_run(&g, e);
                    let snapshot = &snapshots[run];
                    if snapshot.is_null()
                        || model::finished(&model::statuses(g.a("nodes"), e, snapshot, false))
                    {
                        continue;
                    }
                    open.push(run.to_owned());
                    for item in model::pending(flow.list(), e, snapshot).list() {
                        let mut item = item.clone();
                        item["workflowId"] = g["id"].clone();
                        item["workflowName"] = g["name"].clone();
                        item["runId"] = json!(run);
                        decisions.push(item)
                    }
                }
                for (run, ids) in read {
                    let key = format!("{id}:{run}");
                    if open.contains(&run) && state.log.pace(&run, runlog::millis()) != "ended" {
                        state.settled.lock().await.remove(&key);
                    } else {
                        state
                            .settled
                            .lock()
                            .await
                            .insert(key, (runlog::millis(), ids, snapshots[&run].clone()));
                    }
                }
            }
            let value = json!({"decisions":decisions});
            *collecting = Some((std::time::Instant::now(), value.clone()));
            ok(value)
        }
        ("GET", ["workflows", _]) => {
            let g = state.store.load(id)?;
            Ok((200, g.clone(), Some(version(&g))))
        }
        ("PUT", ["workflows", _]) => {
            need_id(id)?;
            if body.s("id") != id {
                return Err(Error::new(400, "워크플로 ID가 일치하지 않습니다."));
            }
            let lock = state.lock(id);
            let _guard = lock.lock().await;
            let current = match state.store.load(id) {
                Ok(g) => Some(g),
                Err(e) if e.status == 404 => None,
                Err(e) => return Err(e),
            };
            if if_match.is_some_and(|h| !valid_match(h, current.as_ref())) {
                let mut r = json!({"error":if current.is_some(){"문서가 그 사이에 바뀌었습니다(If-Match 불일치). 최신본을 GET 으로 다시 읽어 변경을 합친 뒤 그 ETag 로 다시 보내세요."}else{"저장된 문서가 없어 If-Match 와 맞출 수 없습니다."}});
                if let Some(g) = current {
                    r["version"] = json!(version(&g))
                }
                return Ok((409, r, None));
            }
            let layout = query.split('&').any(|q| q == "layout=auto");
            if layout {
                if let Some(nodes) = body["nodes"].as_array_mut() {
                    for n in nodes {
                        if n.is_object() && n.get("position").is_none() {
                            n["position"] = json!({"x":0,"y":0})
                        }
                    }
                }
            }
            if current.is_some() {
                drop_keys(&mut body, &["executions", "automations"])
            }
            let mut g = validate::validate(&body)?;
            if layout {
                g["nodes"] =
                    workflow_core::layout::auto_layout(g.a("nodes"), g.a("edges"), &Value::Null)
            }
            if let Some(current) = current {
                let mut executions = current.a("executions").to_vec();
                for e in &mut executions {
                    if e.s("runId").is_empty()
                        && !current.s("runId").is_empty()
                        && current.s("runId") != g.s("runId")
                    {
                        e["runId"] = current["runId"].clone()
                    }
                }
                if current.get("executions").is_some() {
                    g["executions"] = json!(executions)
                }
                copy_keys(&mut g, &current, &["automations"]);
            }
            let stored = state.store.save(&g)?;
            Ok((200, stored.clone(), Some(version(&stored))))
        }
        ("DELETE", ["workflows", _]) => {
            need_id(id)?;
            let lock = state.lock(id);
            let _guard = lock.lock().await;
            state.store.remove(id)?;
            ok(json!({"deleted":true}))
        }
        ("GET", ["workflows", _, "flow"]) => {
            need_id(id)?;
            let g = state.store.load(id)?;
            ok(workflow::flow(&g, &state.store.linked(&g)?)?)
        }
        ("GET", ["workflows", _, "check"]) => {
            need_id(id)?;
            ok(execute::preflight(&state.store, &state.store.load(id)?))
        }
        ("PUT", ["workflows", _, "executions"]) => {
            need_id(id)?;
            let run = body.s("runId");
            if !validate::valid_id(run) || !body["executions"].is_array() {
                return Err(Error::new(
                    400,
                    "{\"runId\":\"<run_id>\",\"launch\":\"<실행 로그 ID>\",\"executions\":[...]} 형식이어야 합니다.",
                ));
            }
            let launch = if runlog::valid_launch(id, body.s("launch")) {
                body.s("launch")
            } else {
                ""
            };
            let meta = state.log.meta(launch);
            if meta.s("coordinatorTerminal").is_empty()
                && validate::matches(r"^term_[a-zA-Z0-9-]{1,128}$", body.s("coordinatorTerminal"))
            {
                let _ = state.log.patch(
                    launch,
                    &json!({"coordinatorTerminal":body["coordinatorTerminal"]}),
                );
            }
            let prefix = meta
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    entries(&meta["inputs"])
                        .iter()
                        .filter(|(_, v)| workflow_core::truth(v))
                        .map(|(_, v)| v.text())
                        .collect::<Vec<_>>()
                        .join("·")
                });
            let lock = state.lock(id);
            let _guard = lock.lock().await;
            let mut g = state.store.load(id)?;
            let mut others = g
                .a("executions")
                .iter()
                .filter(|e| model::execution_run(&g, e) != run)
                .map(|e| {
                    let mut e = e.clone();
                    let own = model::execution_run(&g, &e).to_owned();
                    if !own.is_empty() {
                        e["runId"] = json!(own)
                    }
                    e
                })
                .collect::<Vec<_>>();
            let previous = g
                .a("executions")
                .iter()
                .filter(|e| model::execution_run(&g, e) == run)
                .cloned()
                .collect::<Vec<_>>();
            let mut registered = vec![];
            for e in body.a("executions") {
                if others.iter().any(|o| o.s("id") == e.s("id")) {
                    return Err(Error::new(
                        400,
                        format!(
                            "실행 ID {} 는 다른 Run 의 실행이 이미 쓰고 있습니다. 실행 ID 를 \"{run}-<n>\" 형식으로 바꿔 다시 보내세요.",
                            e.s("id")
                        ),
                    ));
                }
                if !e.is_object() {
                    registered.push(e.clone());
                    continue;
                }
                let mut e = e.clone();
                let before = model::find(&previous, e.s("id")).unwrap_or(&Value::Null);
                e["runId"] = json!(run);
                if !before["decisions"].is_null() && e["decisions"].is_null() {
                    copy_keys(&mut e, before, &["decisions", "skipped"])
                }
                for k in ["inputs", "values"] {
                    if !before[k].is_null() {
                        e[k] = before[k].clone()
                    } else if !entries(&meta[k]).is_empty() {
                        e[k] = meta[k].clone()
                    }
                }
                if !prefix.is_empty()
                    && e["label"].is_string()
                    && !e.s("label").starts_with(&prefix)
                {
                    e["label"] = json!(if !meta.s("title").is_empty() && meta.n("count") <= 1. {
                        meta.s("title").to_owned()
                    } else {
                        format!("{prefix} {}", e.s("label"))
                            .chars()
                            .take(200)
                            .collect()
                    })
                }
                registered.push(e);
            }
            let remove = (others.len() + registered.len())
                .saturating_sub(100)
                .min(others.len());
            others.drain(..remove);
            others.extend(registered);
            g["executions"] = json!(others);
            g["runId"] = json!(run);
            let stored = state.store.save(&g)?;
            register_log(&state, &stored, run, launch);
            ok(stored)
        }
        ("GET", ["workflows", _, "executions", execution, "decisions"]) => {
            need_id(id)?;
            need_id(execution)?;
            let g = state.store.load(id)?;
            let e = model::find(g.a("executions"), execution)
                .ok_or_else(|| Error::new(404, "이 워크플로에 등록된 실행이 아닙니다."))?;
            let users = state
                .store
                .linked(&g)
                .and_then(|linked| Ok(workflow::flow(&g, &linked)?))
                .map(|flow| model::user_decisions(flow.list(), e))
                .unwrap_or(json!([]));
            ok(
                json!({"decisions":e.get("decisions").cloned().unwrap_or(object()),"skipped":e.a("skipped"),"skippedTasks":model::execution_tasks(e,&strings(&e["skipped"])),"userDecisions":users,"userSection":model::user_section(&users)}),
            )
        }
        ("POST", ["workflows", _, "executions", execution, "decisions"]) => {
            need_id(id)?;
            need_id(execution)?;
            if let Some(via) = body.get("via") {
                if !via.is_string()
                    || via.text().trim().is_empty()
                    || validate::length(via.text()) > 40
                    || validate::control(via.text())
                {
                    return Err(Error::new(400, "via 는 제어 문자 없는 1~40자여야 합니다."));
                }
            }
            if !body["node"].is_string()
                || !validate::matches(r"^[a-zA-Z0-9_.-]{1,400}$", body.s("node"))
                || !body["outputs"].is_array()
                || body.a("outputs").iter().any(|o| !o.is_string())
            {
                return Err(Error::new(
                    400,
                    "{\"node\":\"<분기 nodeId>\",\"outputs\":[\"<출력 id>\"]} 형식이어야 합니다.",
                ));
            }
            let lock = state.lock(id);
            let _guard = lock.lock().await;
            let mut g = state.store.load(id)?;
            let e = model::find(g.a("executions"), execution)
                .ok_or_else(|| Error::new(404, "이 워크플로에 등록된 실행이 아닙니다."))?;
            let flow = workflow::flow(&g, &state.store.linked(&g)?)?;
            let node = body.s("node");
            let outputs = strings(&body["outputs"]);
            if let Some(error) = model::decision_error(flow.list(), &e["decisions"], node, &outputs)
            {
                return Err(Error::new(
                    if e["decisions"][node].is_null() {
                        400
                    } else {
                        409
                    },
                    error,
                ));
            }
            let effect = model::apply_decision(flow.list(), e, node, &outputs);
            let updated = &effect["execution"];
            let index = g
                .a("executions")
                .iter()
                .position(|e| e.s("id") == *execution)
                .unwrap();
            g["executions"][index] = updated.clone();
            let stored = state.store.save(&g)?;
            let run = model::execution_run(&stored, updated);
            if !run.is_empty() {
                register_log(&state, &stored, run, "");
                if body.s("by") == "user" && !effect.b("repeated") {
                    let stage = model::find(flow.list(), node).unwrap();
                    let labels = outputs
                        .iter()
                        .map(|o| {
                            stage["outputLabels"]
                                .get(o)
                                .and_then(Value::as_str)
                                .unwrap_or(o)
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    let via = if body.s("via").is_empty() {
                        "캔버스"
                    } else {
                        body.s("via").trim()
                    };
                    let mut event = json!({"type":"gate","message":format!("{} {}: {via}에서 사용자가 {labels} 선택",stage.get("label").and_then(Value::as_str).unwrap_or(node),updated.s("label"))});
                    if let Some(task) = model::execution_tasks(updated, &[node.into()]).first() {
                        event["taskId"] = json!(task)
                    }
                    let _ = state.log.append_run(run, &event);
                }
                if !effect["loop"].is_null() && !effect.b("repeated") {
                    let lp = &effect["loop"];
                    let stage = model::find(flow.list(), lp.s("to"));
                    let _=state.log.append_run(run,&json!({"type":"note","message":format!("{}: 되돌아가기 → {} {}회차 (남은 반복 {}회)",updated.s("label"),stage.and_then(|s|s.get("label")).and_then(Value::as_str).unwrap_or(lp.s("to")),lp.n("pass"),lp.n("remaining"))}));
                }
                if !effect["exhausted"].is_null() {
                    let exhausted = &effect["exhausted"];
                    let _=state.log.append_run(run,&json!({"type":"note","message":format!("{}: 최대 반복 {}회를 다 써서 {} 로 진행",updated.s("label"),exhausted.n("max"),exhausted.s("output"))}));
                }
            }
            let mut r = json!({"decisions":updated["decisions"],"skipped":updated["skipped"],"skippedTasks":model::execution_tasks(updated,&strings(&updated["skipped"]))});
            copy_keys(&mut r, &effect, &["loop", "exhausted"]);
            ok(r)
        }
        ("PATCH", ["workflows", _, "executions", execution, "bindings"]) => {
            need_id(id)?;
            need_id(execution)?;
            let bindings = &body["bindings"];
            if !bindings.is_object()
                || entries(bindings).is_empty()
                || entries(bindings).iter().any(|(k, v)| {
                    !validate::valid_id(k) || !v.is_string() || !validate::valid_id(v.text())
                })
            {
                return Err(Error::new(
                    400,
                    "{\"bindings\":{\"<nodeId>\":\"<task_id>\", ...}} 형식이어야 합니다.",
                ));
            }
            let lock = state.lock(id);
            let _guard = lock.lock().await;
            let mut g = state.store.load(id)?;
            let index = g
                .a("executions")
                .iter()
                .position(|e| e.s("id") == *execution)
                .ok_or_else(|| Error::new(404, "이 워크플로에 등록된 실행이 아닙니다."))?;
            for (k, v) in entries(bindings) {
                if !model::find(g.a("nodes"), &k).is_some_and(model::executable) {
                    return Err(Error::new(
                        400,
                        format!("'{k}' 는 이 워크플로의 실행 단계가 아닙니다."),
                    ));
                }
                g["executions"][index]["bindings"][k] = v
            }
            let stored = state.store.save(&g)?;
            let e = &stored["executions"][index];
            register_log(&state, &stored, model::execution_run(&stored, e), "");
            ok(e.clone())
        }
        ("POST", ["workflows", _, "execute"]) => {
            need_id(id)?;
            let g = state.store.load(id)?;
            let settings = execute::settings(&state, &g, &body).await?;
            execute::start(state.clone(), g, settings).await?;
            ok(json!({"launched":true}))
        }
        ("POST", ["workflows", _, "executions", execution, "spawn"]) => {
            spawn(state, id, execution, body).await
        }
        ("GET", ["workflows", _, "automations"]) => {
            need_id(id)?;
            let g = state.store.load(id)?;
            let r = state.bridge.read("automations", json!([]), None).await;
            let reachable = r.is_ok();
            let states = r.unwrap_or(json!([]));
            ok(
                json!({"reachable":reachable,"automations":g.a("automations").iter().map(|c|{let mut c=c.clone();c["state"]=states.list().iter().find(|s|s.s("orcaId")==c.s("orcaId")).cloned().unwrap_or(Value::Null);c}).collect::<Vec<_>>()}),
            )
        }
        ("POST", ["workflows", _, "automations"]) => {
            need_id(id)?;
            let g = state.store.load(id)?;
            let settings = execute::settings(&state, &g, &body).await?;
            let name = body.s("name").trim();
            let mut config = json!({"id":uuid::Uuid::new_v4().to_string(),"name":name,"trigger":body.s("trigger").trim(),"project":settings["project"],"count":settings["count"],"cleanup":settings["cleanup"]});
            if !body.s("time").is_empty() {
                config["time"] = body["time"].clone()
            }
            if !body["day"].is_null() && body["day"] != "" {
                config["day"] = body["day"]
                    .as_f64()
                    .or_else(|| body["day"].as_str().and_then(|s| s.parse().ok()))
                    .map(|v| json!(v))
                    .unwrap_or(Value::Null)
            }
            if !entries(&settings["inputs"]).is_empty() {
                config["inputs"] = settings["inputs"].clone()
            }
            if !entries(&settings["given"]).is_empty() {
                config["values"] = settings["given"].clone()
            }
            let mut trial = g.clone();
            trial["automations"] = json!(
                g.a("automations")
                    .iter()
                    .cloned()
                    .chain([config.clone()])
                    .collect::<Vec<_>>()
            );
            validate::validate(&trial)?;
            let prompt = format!(
                "workflow-canvas 자동화 「{name}」 실행이다. 자동화를 설정하거나 조회하지 말고, 다음 명령으로 이번 실행의 브리프를 받아라: curl -s -X POST {}/api/workflows/{id}/automations/{}/brief 응답 JSON 의 briefPath 파일을 읽고 그 지시대로 코디네이터로서 끝까지 수행하라. 응답에 error 가 있으면 그 내용을 이 터미널에 보고하고 종료하라.",
                state.base,
                config.s("id")
            );
            let mut input = config.clone();
            input["name"] = json!(
                format!("{} · {name}", g.s("name"))
                    .chars()
                    .take(120)
                    .collect::<String>()
            );
            input["prompt"] = json!(prompt);
            config["orcaId"] = state
                .bridge
                .action("createAutomation", json!([input]))
                .await?;
            let lock = state.lock(id);
            let _guard = lock.lock().await;
            let mut latest = state.store.load(id)?;
            latest["automations"] = json!(
                latest
                    .a("automations")
                    .iter()
                    .cloned()
                    .chain([config])
                    .collect::<Vec<_>>()
            );
            ok(state.store.save(&latest)?)
        }
        ("POST", ["workflows", _, "automations", aid, "run"]) => {
            need_id(id)?;
            need_id(aid)?;
            let g = state.store.load(id)?;
            let config = model::find(g.a("automations"), aid)
                .filter(|c| !c.s("orcaId").is_empty())
                .ok_or_else(|| Error::new(404, "자동화를 찾을 수 없습니다."))?;
            state
                .bridge
                .action("runAutomation", json!([config["orcaId"]]))
                .await?;
            ok(json!({"started":true}))
        }
        ("DELETE", ["workflows", _, "automations", aid]) => {
            need_id(id)?;
            need_id(aid)?;
            let lock = state.lock(id);
            let _guard = lock.lock().await;
            let mut g = state.store.load(id)?;
            let config = model::find(g.a("automations"), aid)
                .ok_or_else(|| Error::new(404, "자동화를 찾을 수 없습니다."))?;
            if !config.s("orcaId").is_empty() {
                let states = state.bridge.read("automations", json!([]), None).await?;
                if states
                    .list()
                    .iter()
                    .any(|s| s.s("orcaId") == config.s("orcaId"))
                {
                    state
                        .bridge
                        .action("removeAutomation", json!([config["orcaId"]]))
                        .await?;
                }
            }
            g["automations"] = json!(
                g.a("automations")
                    .iter()
                    .filter(|c| c.s("id") != *aid)
                    .cloned()
                    .collect::<Vec<_>>()
            );
            ok(state.store.save(&g)?)
        }
        ("POST", ["workflows", _, "automations", aid, "brief"]) => {
            need_id(id)?;
            need_id(aid)?;
            let g = state.store.load(id)?;
            let config = model::find(g.a("automations"), aid)
                .ok_or_else(|| Error::new(404, "이 워크플로에 등록된 자동화가 아닙니다."))?;
            let mut settings = execute::settings(&state, &g, config).await?;
            settings["automation"] = json!({"id":config["id"],"name":config["name"]});
            let prepared = execute::prepare(&state, &g, &settings).await?;
            let _=state.log.append(prepared.s("logId"),&json!({"type":"coordinator","message":"자동화 에이전트가 브리프를 받아 코디네이터로 시작"}));
            ok(json!({"briefPath":prepared["briefPath"]}))
        }
        ("GET", ["workflows", _, "logs"]) => {
            need_id(id)?;
            adopt(&state, id);
            ok(state.log.list(id)?)
        }
        ("GET", ["workflows", _, "logs", log]) => {
            adopt(&state, id);
            let detail = state.log.detail(id, log)?;
            let mut results = Value::Null;
            let mut error = false;
            if !detail["meta"].s("runId").is_empty() && !detail["meta"].a("executions").is_empty() {
                match state
                    .bridge
                    .read("snapshot", json!([detail["meta"]["runId"]]), None)
                    .await
                {
                    Ok(snapshot) => {
                        let _ = state.log.observe(&snapshot);
                        results = model::results(detail["meta"].a("executions"), &snapshot)
                    }
                    Err(_) => error = true,
                }
            }
            let mut fresh = if results.is_null() {
                detail
            } else {
                state.log.detail(id, log)?
            };
            fresh["results"] = results;
            if error {
                fresh["resultsError"] = json!("Orca에서 이 Run을 조회하지 못했습니다.")
            }
            ok(fresh)
        }
        ("GET", ["workflows", _, "logs", log, "files", name]) => {
            ok(state.log.file(id, log, name)?)
        }
        ("POST", ["workflows", _, "logs", log, "events"]) => {
            if !runlog::valid_launch(id, log) {
                return Err(Error::new(400, "올바르지 않은 실행 로그 ID입니다."));
            }
            let message = body
                .s("message")
                .chars()
                .map(|c| if c <= '\u{1f}' && c != '\n' { ' ' } else { c })
                .collect::<String>()
                .trim()
                .to_owned();
            if !["note", "gate", "worker", "error", "report"].contains(&body.s("type"))
                || message.is_empty()
                || validate::length(&message) > 2000
                || (body.get("taskId").is_some()
                    && (!body["taskId"].is_string() || !validate::valid_id(body.s("taskId"))))
            {
                return Err(Error::new(
                    400,
                    "type 은 note·gate·worker·error·report 중 하나, message 는 1~2000자여야 합니다.",
                ));
            }
            state.log.detail(id, log)?;
            let mut event = json!({"type":body["type"],"message":message});
            if !body.s("taskId").is_empty() {
                event["taskId"] = body["taskId"].clone()
            }
            state.log.append(log, &event)?;
            ok(json!({"logged":true}))
        }
        ("POST", ["generations"]) => generation_start(state, body).await,
        ("GET", ["generations", gid]) => {
            let gens = state.generations.lock().await;
            let item = gens.get(*gid).ok_or_else(|| {
                Error::new(
                    404,
                    "생성 요청을 찾을 수 없습니다(서버가 다시 시작되었을 수 있습니다).",
                )
            })?;
            ok(view_generation(item))
        }
        ("PUT", ["generations", gid]) => generation_result(state, gid, body).await,
        _ => Err(Error::new(404, "API를 찾을 수 없습니다.")),
    }
}

async fn spawn(state: Arc<State>, id: &str, execution: &str, body: Value) -> Result<Reply> {
    need_id(id)?;
    need_id(execution)?;
    let node = body.s("node");
    let project = body.s("project");
    if !validate::valid_id(node)
        || !body["project"].is_string()
        || !body["items"].is_array()
        || body.a("items").len() > 20
        || body
            .a("items")
            .iter()
            .any(|v| !v.is_string() || !validate::valid_name(v.text()))
    {
        return Err(Error::new(
            400,
            "{\"node\":\"<링크 nodeId>\",\"project\":\"<실행 프로젝트>\",\"items\":[\"<항목>\", ...]} 형식이어야 합니다. 항목은 20개까지, 영문·숫자·. _ - 만 쓴다.",
        ));
    }
    let lock = state.lock(&format!("spawn:{id}:{execution}:{node}"));
    let _guard = lock.lock().await;
    let graph = state.store.load(id)?;
    let e = model::find(graph.a("executions"), execution)
        .ok_or_else(|| Error::new(404, "이 워크플로에 등록된 실행이 아닙니다."))?;
    let link = model::find(graph.a("nodes"), node)
        .filter(|n| model::spawn(n) && !n["data"].s("workflowId").is_empty())
        .ok_or_else(|| Error::new(400, "항목마다 따로 실행하는 링크 노드가 아닙니다."))?;
    let target = state
        .store
        .load(link["data"].s("workflowId"))
        .map_err(|_| Error::new(400, "링크가 가리키는 워크플로를 찾지 못했습니다."))?;
    let inputs = target
        .a("nodes")
        .iter()
        .filter(|n| model::create(n) && n["data"].s("nameSource") == "input")
        .collect::<Vec<_>>();
    if inputs.len() != 1 {
        return Err(Error::new(
            400,
            format!(
                "'{}'에는 항목을 받을 「실행 시 입력」 워크트리 그룹이 정확히 하나 있어야 합니다.",
                target.s("name")
            ),
        ));
    }
    let requested = e["spawned"][node]
        .list()
        .iter()
        .filter(|r| r.s("error").is_empty())
        .map(|r| r.s("item"))
        .collect::<Vec<_>>();
    let parent_run = model::execution_run(&graph, e);
    let parent_launch = state.log.owner(parent_run);
    let master = parent_launch
        .as_ref()
        .map(|l| state.log.meta(l))
        .unwrap_or(Value::Null);
    let mut passed = object();
    for v in target.a("variables") {
        if !master["values"].s(v.s("key")).is_empty() {
            passed[v.s("key")] = master["values"][v.s("key")].clone()
        }
    }
    let origin = format!(
        "「{}」 {} 의 {}",
        graph.s("name"),
        e.s("label"),
        if link["data"].s("label").is_empty() {
            "링크"
        } else {
            link["data"].s("label")
        }
    );
    let sub = link["data"].s("spawnAs") == "subcoordinator";
    let mut results = vec![];
    for item in model::unique(strings(&body["items"])) {
        let mut result = json!({"item":item,"at":crate::bridge::now(),"workflowId":target["id"]});
        if requested.contains(&item.as_str()) {
            result["status"] = json!("already");
            results.push(result);
            continue;
        }
        let attempt=async{let input=json!({"count":1,"project":project,"inputs":{inputs[0].s("id"):item},"cleanup":target.get("cleanup").cloned().unwrap_or(json!({"coordinator":false,"worktrees":false,"sessions":true})),"values":passed});let mut settings=execute::settings(&state,&target,&input).await?;settings["origin"]=json!(origin);if sub{let mut parent=json!({"workflowId":id,"executionId":execution,"node":node});if let Some(l)=&parent_launch{parent["launch"]=json!(l)}execute::prepare_sub(&state,&target,settings,parent,inputs[0].s("id")).await}else{let launch=execute::start(state.clone(),target.clone(),settings).await?;Ok(json!({"launch":launch}))}}.await;
        match attempt {
            Ok(value) => {
                for (k, v) in entries(&value) {
                    result[k] = v
                }
                result["status"] = json!(if sub { "prepared" } else { "requested" })
            }
            Err(error) => {
                result["status"] = json!("failed");
                result["error"] = json!(error.message.chars().take(500).collect::<String>())
            }
        }
        results.push(result);
    }
    if sub && results.iter().any(|r| r.s("status") == "prepared") {
        if let Some(launch) = &parent_launch {
            let _ = state.log.patch(launch, &json!({"subcoordinators":true}));
        }
    }
    let fresh = results
        .iter()
        .filter(|r| r.s("status") != "already")
        .map(|r| {
            let mut r = r.clone();
            drop_keys(&mut r, &["status"]);
            r
        })
        .collect::<Vec<_>>();
    if !fresh.is_empty() {
        let lock = state.lock(id);
        let _guard = lock.lock().await;
        let mut latest = state.store.load(id)?;
        if let Some(index) = latest
            .a("executions")
            .iter()
            .position(|e| e.s("id") == execution)
        {
            let e = &mut latest["executions"][index];
            if !e["spawned"].is_object() {
                e["spawned"] = object()
            }
            e["spawned"][node] = json!(
                e["spawned"][node]
                    .list()
                    .iter()
                    .cloned()
                    .chain(fresh)
                    .collect::<Vec<_>>()
            );
            state.store.save(&latest)?;
        }
    }
    ok(json!({"results":results}))
}
async fn generation_start(state: Arc<State>, body: Value) -> Result<Reply> {
    let kind = body.s("kind");
    let request = body.s("prompt").trim();
    if !["workflow", "brief"].contains(&kind) {
        return Err(Error::new(400, "kind 는 workflow 또는 brief 여야 합니다."));
    }
    if request.is_empty() || validate::length(request) > 10000 {
        return Err(Error::new(400, "요청을 1~10000자로 적으세요."));
    }
    if state
        .generations
        .lock()
        .await
        .values()
        .filter(|v| view_generation(v).s("status") == "pending")
        .count()
        >= 5
    {
        return Err(Error::new(
            429,
            "생성 중인 요청이 많습니다. 끝난 뒤 다시 시도하세요.",
        ));
    }
    let project = body.s("project");
    let locations = state
        .bridge
        .read("locations", json!([]), None)
        .await
        .map_err(|_| Error::new(503, "Orca 프로젝트 목록을 확인할 수 없습니다."))?;
    if !locations
        .a("projects")
        .iter()
        .any(|p| p.s("path") == project)
    {
        return Err(Error::new(
            400,
            "생성 에이전트가 작업할 프로젝트를 Orca에 열린 프로젝트 중에서 고르세요.",
        ));
    }
    let graph = if kind == "brief" {
        let g = validate::validate(&body["workflow"])?;
        if !g
            .a("nodes")
            .iter()
            .any(|n| n.s("id") == body.s("nodeId") && n.s("type") == "stage")
        {
            return Err(Error::new(400, "지침을 만들 단계를 찾지 못했습니다."));
        }
        g
    } else {
        Value::Null
    };
    let id = uuid::Uuid::new_v4().to_string();
    let dir = state.store.root.join(".generations").join(&id);
    crate::store::mkdir(&dir)?;
    let prompt_path = dir.join("prompt.md");
    let mut input = json!({"request":request,"resultUrl":format!("{}/api/generations/{id}",state.base),"resultFile":dir.join("result.json"),"saved":state.store.list()?,"graph":graph,"nodeId":body["nodeId"]});
    let prompt = if kind == "workflow" {
        input["models"] = state.model_list().await?["models"].clone();
        prompts::workflow_prompt(&input)
    } else {
        prompts::brief_prompt(&input)
    };
    crate::store::write_private(&prompt_path, prompt.as_bytes())?;
    let mut item = json!({"id":id,"kind":kind,"status":"pending","createdAt":runlog::millis(),"project":project});
    if kind == "brief" {
        item["nodeId"] = body["nodeId"].clone()
    }
    state
        .generations
        .lock()
        .await
        .insert(id.clone(), item.clone());
    let result = state
        .bridge
        .action(
            "launchGenerator",
            json!([
                project,
                format!(
                    "{} 파일을 읽고 그대로 수행해줘. {} 역할이다.",
                    prompt_path.display(),
                    if kind == "workflow" {
                        "자연어 요청으로 워크플로를 만드는"
                    } else {
                        "워크플로 단계의 지침을 쓰는"
                    }
                )
            ]),
        )
        .await;
    match result {
        Err(e) => {
            state.generations.lock().await.remove(&id);
            Err(Error::new(
                503,
                format!("생성 에이전트를 띄우지 못했습니다: {}", e.message),
            ))
        }
        Ok(result) => {
            let terminal = result.s("terminal");
            if !terminal.is_empty() {
                let label = model::find(graph.a("nodes"), body.s("nodeId"))
                    .map(|n| n["data"].s("label"))
                    .filter(|s| !s.is_empty())
                    .unwrap_or("단계");
                let _ = state
                    .bridge
                    .action(
                        "renameTerminal",
                        json!([
                            terminal,
                            if kind == "workflow" {
                                "워크플로 생성".into()
                            } else {
                                format!("지침 생성 · {label}")
                            }
                        ]),
                    )
                    .await;
            }
            ok(item)
        }
    }
}
async fn generation_result(state: Arc<State>, id: &str, body: Value) -> Result<Reply> {
    let item = state
        .generations
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| Error::new(404, "생성 요청을 찾을 수 없습니다."))?;
    if view_generation(&item).s("status") != "pending" {
        return Err(Error::new(409, "이미 끝난 생성 요청입니다."));
    }
    let mut next = item.clone();
    if body["error"].is_string() && entries(&body).len() == 1 {
        next["status"] = json!("failed");
        next["error"] = json!(if body.s("error").is_empty() {
            "에이전트가 만들지 못했습니다.".into()
        } else {
            body.s("error").chars().take(2000).collect::<String>()
        });
        state.generations.lock().await.insert(id.into(), next);
        return ok(json!({"recorded":true}));
    }
    if item.s("kind") == "brief" {
        if !body["description"].is_string()
            || body.s("description").trim().is_empty()
            || validate::length(body.s("description")) > 20000
        {
            return Err(Error::new(
                400,
                "description 은 1~20000자 문자열이어야 합니다.",
            ));
        }
        if body.get("label").is_some()
            && (!body["label"].is_string() || validate::length(body.s("label")) > 500)
        {
            return Err(Error::new(400, "label 은 500자 이하 문자열이어야 합니다."));
        }
        next["description"] = body["description"].clone();
        if !body.s("label").trim().is_empty() {
            next["label"] = json!(body.s("label").trim())
        }
    } else {
        let graph = validate::validate(&prompts::generated(
            &body,
            &uuid::Uuid::new_v4().to_string(),
        )?)?;
        if !graph.a("nodes").iter().any(model::executable) {
            return Err(Error::new(
                400,
                "실행할 단계(worker·gate·branch·workflow)가 하나 이상 필요합니다.",
            ));
        }
        let linked = state.store.linked(&graph)?;
        let all = std::iter::once(graph.clone())
            .chain(entries(&linked).into_iter().map(|(_, v)| v))
            .collect::<Vec<_>>();
        workflow::check("branches", &all, &linked)?;
        state.store.save(&graph)?;
        next["workflowId"] = graph["id"].clone();
    }
    next["status"] = json!("done");
    state.generations.lock().await.insert(id.into(), next);
    ok(json!({"accepted":true}))
}
pub fn background(state: Arc<State>, reap_ms: u64) {
    let observer = state.clone();
    tokio::spawn(async move {
        loop {
            for run in observer.log.watch_targets() {
                if let Ok(snapshot) = observer
                    .bridge
                    .read(
                        "snapshot",
                        json!([run, observer.watch_ms]),
                        Some(observer.watch_ms),
                    )
                    .await
                {
                    let _ = observer.log.observe(&snapshot);
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(observer.watch_ms)).await;
        }
    });
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(reap_ms)).await;
            for item in state
                .log
                .coordinators_close(runlog::millis(), 600000)
                .list()
            {
                let terminal = item.s("terminal");
                if let Ok(open) = state.bridge.action("terminalOpen", json!([terminal])).await {
                    if open == json!(true) {
                        if state
                            .bridge
                            .action("closeTerminal", json!([terminal]))
                            .await
                            .is_err()
                        {
                            continue;
                        }
                    }
                    let _=state.log.append(item.s("id"),&json!({"type":"coordinator-closed","message":if open==json!(true){format!("실행이 끝나 캔버스 서버가 코디네이터 터미널을 닫음 · {terminal}")}else{format!("코디네이터 터미널이 이미 닫혀 있음 · {terminal}")}}));
                }
            }
            for item in state.log.coordinators_watch(runlog::millis()).list() {
                if state
                    .bridge
                    .action("terminalOpen", json!([item["terminal"]]))
                    .await
                    .is_ok_and(|open| open == json!(false))
                {
                    if !item.s("runId").is_empty() {
                        if let Ok(snapshot) = state
                            .bridge
                            .read("snapshot", json!([item["runId"]]), None)
                            .await
                        {
                            let _ = state.log.observe(&snapshot);
                        }
                    }
                    let _ = state.log.mark_lost(item.s("id"), item.s("terminal"));
                }
            }
        }
    });
}
